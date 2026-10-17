import type { ImapFlow } from "imapflow";
import { muellBewerten, nachAbsender, type AbsenderGruppe } from "./claude.js";
import { db, log, type AccountRow } from "./db.js";
import { gmail } from "./providers/gmail.js";
import { withImap } from "./providers/imap.js";
import { accessToken } from "./providers/oauth.js";
import { graph } from "./providers/outlook.js";

// Aufräumen voller Postfächer. Der Agent verschiebt nur in den Papierkorb («Gelöschte Elemente»),
// nie endgültig. Markierte (Stern/Fahne) und wichtige Mails bleiben unberührt.

export interface StichprobenMail {
  adresse: string;
  name: string | null;
  betreff: string;
}

export interface Aufraeumer {
  kategorien: Record<string, string>; // key → Titel
  vorschau(account: AccountRow): Promise<{ kategorien: { key: string; titel: string; anzahl: number }[]; papierkorb: number }>;
  stichprobe(account: AccountRow, kategorie: string): Promise<StichprobenMail[]>;
  /** Mails der Absender in dieser Kategorie in den Papierkorb, bis `ende`. Gibt Anzahl und noch offene Absender zurück. */
  verschieben(account: AccountRow, kategorie: string, adressen: string[], ende: number): Promise<{ verschoben: number; rest: string[] }>;
}

const vorTagen = (t: number) => new Date(Date.now() - t * 86_400_000);

// ─── Gmail ───────────────────────────────────────────────────────────────────

const G_SCHUTZ = "-is:starred -is:important";
const G_KAT: Record<string, { titel: string; q: string }> = {
  werbung: { titel: "Werbung (Tab «Werbung»), älter als 30 Tage", q: `category:promotions older_than:30d ${G_SCHUTZ}` },
  sozial: { titel: "Soziale Netzwerke, älter als 30 Tage", q: `category:social older_than:30d ${G_SCHUTZ}` },
  foren: { titel: "Foren und Mailinglisten, älter als 30 Tage", q: `category:forums older_than:30d ${G_SCHUTZ}` },
  updates: { titel: "Benachrichtigungen (Tab «Updates»), älter als 1 Jahr", q: `category:updates older_than:1y ${G_SCHUTZ}` },
  gross: { titel: "Grosse Mails über 10 MB, älter als 2 Jahre", q: `larger:10M older_than:2y ${G_SCHUTZ}` },
  spam: { titel: "Spam", q: "in:spam" },
};

interface GListe {
  messages?: { id: string }[];
  resultSizeEstimate?: number;
}
const gPfad = (q: string, max: number) =>
  `/messages?q=${encodeURIComponent(q)}&maxResults=${max}&includeSpamTrash=${/in:(spam|trash)/.test(q)}`;

function absenderZerlegen(from: string): { adresse: string; name: string | null } {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  return m ? { adresse: m[2].trim(), name: m[1].trim() || null } : { adresse: from.trim(), name: null };
}

const gmailAufraeumer: Aufraeumer = {
  kategorien: Object.fromEntries(Object.entries(G_KAT).map(([k, v]) => [k, v.titel])),

  async vorschau(account) {
    const schaetzung = async (q: string) => (await gmail<GListe>(account, gPfad(q, 1))).resultSizeEstimate ?? 0;
    const kategorien = await Promise.all(
      Object.entries(G_KAT).map(async ([key, k]) => ({ key, titel: k.titel, anzahl: await schaetzung(k.q) })),
    );
    return { kategorien, papierkorb: await schaetzung("in:trash") };
  },

  async stichprobe(account, kategorie) {
    const ids = ((await gmail<GListe>(account, gPfad(G_KAT[kategorie].q, 300))).messages ?? []).map((m) => m.id);
    const mails: StichprobenMail[] = [];
    // Kopfzeilen je 25 parallel holen.
    for (let i = 0; i < ids.length; i += 25) {
      const teil = await Promise.all(
        ids.slice(i, i + 25).map((id) =>
          gmail<{ payload?: { headers?: { name: string; value: string }[] } }>(
            account,
            `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
          ),
        ),
      );
      for (const m of teil) {
        const h = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? "";
        mails.push({ ...absenderZerlegen(h("from")), betreff: h("subject") });
      }
    }
    return mails;
  },

  async verschieben(account, kategorie, adressen, ende) {
    let verschoben = 0;
    const rest = [...adressen];
    while (rest.length && Date.now() < ende) {
      const adresse = rest[0].replace(/[^\w.@+-]/g, "");
      const ids = ((await gmail<GListe>(account, gPfad(`${G_KAT[kategorie].q} from:${adresse}`, 500))).messages ?? []).map((m) => m.id);
      if (!ids.length) {
        rest.shift();
        continue;
      }
      await gmail(account, "/messages/batchModify", {
        method: "POST",
        body: JSON.stringify({ ids, addLabelIds: ["TRASH"], removeLabelIds: ["INBOX", "SPAM"] }),
      });
      verschoben += ids.length;
    }
    return { verschoben, rest };
  },
};

// ─── Hotmail (Microsoft Graph) ───────────────────────────────────────────────

const H_SCHUTZ = "flag/flagStatus ne 'flagged' and importance ne 'high'";
const H_KAT: Record<string, { titel: string; ordner: string; filter: () => string }> = {
  sonstige: {
    titel: "Posteingang «Sonstige» (Werbung, Newsletter), älter als 30 Tage",
    ordner: "inbox",
    filter: () => `inferenceClassification eq 'other' and receivedDateTime lt ${vorTagen(30).toISOString()} and ${H_SCHUTZ}`,
  },
  alt_anhaenge: {
    titel: "Mails mit Anhang, älter als 2 Jahre",
    ordner: "inbox",
    filter: () => `hasAttachments eq true and receivedDateTime lt ${vorTagen(730).toISOString()} and ${H_SCHUTZ}`,
  },
  junk: { titel: "Junk-E-Mail", ordner: "junkemail", filter: () => `receivedDateTime lt ${new Date().toISOString()}` },
};

const hListe = (key: string, zusatz: string, top: number, felder: string, zaehlen = false) =>
  `/mailFolders/${H_KAT[key].ordner}/messages?$filter=${encodeURIComponent(H_KAT[key].filter() + zusatz)}&$top=${top}&$select=${felder}${zaehlen ? "&$count=true" : ""}`;

/** Bis zu 20 Mails pro Sammelanfrage nach «Gelöschte Elemente». Gibt die Anzahl Erfolge zurück. */
async function hVerschieben(account: AccountRow, ids: string[]): Promise<number> {
  let erfolgreich = 0;
  for (let i = 0; i < ids.length; i += 20) {
    const requests = ids.slice(i, i + 20).map((id, n) => ({
      id: String(n),
      method: "POST",
      url: `/me/messages/${id}/move`,
      headers: { "Content-Type": "application/json" },
      body: { destinationId: "deleteditems" },
    }));
    const r = await fetch("https://graph.microsoft.com/v1.0/$batch", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await accessToken(account)}` },
      body: JSON.stringify({ requests }),
    });
    if (!r.ok) throw new Error(`Hotmail Sammelanfrage: ${r.status} ${await r.text()}`);
    erfolgreich += ((await r.json()) as { responses: { status: number }[] }).responses.filter((x) => x.status < 300).length;
  }
  return erfolgreich;
}

const hotmailAufraeumer: Aufraeumer = {
  kategorien: Object.fromEntries(Object.entries(H_KAT).map(([k, v]) => [k, v.titel])),

  async vorschau(account) {
    const zaehlen = async (key: string) => {
      const r = await graph(account, hListe(key, "", 1, "id", true), { headers: { ConsistencyLevel: "eventual" } });
      return ((await r.json()) as { "@odata.count"?: number })["@odata.count"] ?? 0;
    };
    const kategorien = await Promise.all(
      Object.entries(H_KAT).map(async ([key, k]) => ({ key, titel: k.titel, anzahl: await zaehlen(key) })),
    );
    const g = (await (await graph(account, "/mailFolders/deleteditems?$select=totalItemCount")).json()) as { totalItemCount?: number };
    return { kategorien, papierkorb: g.totalItemCount ?? 0 };
  },

  async stichprobe(account, kategorie) {
    const r = (await (await graph(account, hListe(kategorie, "", 500, "id,subject,from"))).json()) as {
      value: { subject?: string; from?: { emailAddress?: { address?: string; name?: string } } }[];
    };
    return r.value
      .filter((m) => m.from?.emailAddress?.address)
      .map((m) => ({ adresse: m.from!.emailAddress!.address!, name: m.from!.emailAddress!.name ?? null, betreff: m.subject ?? "" }));
  },

  async verschieben(account, kategorie, adressen, ende) {
    let verschoben = 0;
    const rest = [...adressen];
    while (rest.length && Date.now() < ende) {
      const adresse = rest[0].replace(/'/g, "''");
      const ids = (
        (await (await graph(account, hListe(kategorie, ` and from/emailAddress/address eq '${adresse}'`, 100, "id"))).json()) as {
          value: { id: string }[];
        }
      ).value.map((m) => m.id);
      if (!ids.length) {
        rest.shift();
        continue;
      }
      const n = await hVerschieben(account, ids);
      // Nichts verschoben: diesen Absender überspringen statt endlos neu zu versuchen.
      if (n === 0) rest.shift();
      verschoben += n;
    }
    return { verschoben, rest };
  },
};

// ─── Hostpoint / Hostinger (IMAP) ────────────────────────────────────────────

async function ordnerMit(c: ImapFlow, specialUse: string, muster: RegExp): Promise<string | undefined> {
  const liste = await c.list();
  return liste.find((f) => f.specialUse === specialUse)?.path ?? liste.find((f) => muster.test(f.path))?.path;
}

const I_KAT: Record<string, { titel: string; ordner: (c: ImapFlow) => Promise<string | undefined>; suche: () => Record<string, unknown> }> = {
  alt: { titel: "Posteingang, älter als 1 Jahr", ordner: async () => "INBOX", suche: () => ({ before: vorTagen(365), flagged: false }) },
  spam: { titel: "Spam / Junk", ordner: (c) => ordnerMit(c, "\\Junk", /(^|\.)(spam|junk)$/i), suche: () => ({ all: true }) },
};
const iPapierkorb = (c: ImapFlow) => ordnerMit(c, "\\Trash", /(^|\.)(trash|papierkorb|deleted|gelöscht)/i);

const imapAufraeumer: Aufraeumer = {
  kategorien: Object.fromEntries(Object.entries(I_KAT).map(([k, v]) => [k, v.titel])),

  vorschau: (account) =>
    withImap(account, async (c) => {
      const kategorien = [];
      for (const [key, k] of Object.entries(I_KAT)) {
        const pfad = await k.ordner(c);
        let anzahl = 0;
        if (pfad) {
          const lock = await c.getMailboxLock(pfad);
          try {
            anzahl = ((await c.search(k.suche(), { uid: true })) || []).length;
          } finally {
            lock.release();
          }
        }
        kategorien.push({ key, titel: k.titel, anzahl });
      }
      const pk = await iPapierkorb(c);
      const st = pk ? await c.status(pk, { messages: true }) : false;
      return { kategorien, papierkorb: st ? (st.messages ?? 0) : 0 };
    }),

  stichprobe: (account, kategorie) =>
    withImap(account, async (c) => {
      const pfad = await I_KAT[kategorie].ordner(c);
      if (!pfad) return [];
      const lock = await c.getMailboxLock(pfad);
      try {
        const uids = ((await c.search(I_KAT[kategorie].suche(), { uid: true })) || []).sort((a, b) => b - a).slice(0, 400);
        const mails: StichprobenMail[] = [];
        if (uids.length) {
          for await (const m of c.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
            const von = m.envelope?.from?.[0];
            if (von?.address) mails.push({ adresse: von.address, name: von.name || null, betreff: m.envelope?.subject ?? "" });
          }
        }
        return mails;
      } finally {
        lock.release();
      }
    }),

  verschieben: (account, kategorie, adressen, ende) =>
    withImap(account, async (c) => {
      const pfad = await I_KAT[kategorie].ordner(c);
      const ziel = await iPapierkorb(c);
      if (!pfad || !ziel) throw new Error("Papierkorb-Ordner nicht gefunden");
      let verschoben = 0;
      const rest = [...adressen];
      const lock = await c.getMailboxLock(pfad);
      try {
        while (rest.length && Date.now() < ende) {
          const uids = (await c.search({ ...I_KAT[kategorie].suche(), from: rest[0] }, { uid: true })) || [];
          // IMAP sucht «from» als Teilstring; nur exakt passende Absender verschieben.
          const passend: number[] = [];
          if (uids.length) {
            for await (const m of c.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
              if (m.envelope?.from?.[0]?.address?.toLowerCase() === rest[0].toLowerCase()) passend.push(m.uid);
            }
          }
          if (passend.length) await c.messageMove(passend, ziel, { uid: true });
          verschoben += passend.length;
          rest.shift();
        }
      } finally {
        lock.release();
      }
      return { verschoben, rest };
    }),
};

export function aufraeumerFuer(account: AccountRow): Aufraeumer {
  if (account.typ === "imap") return imapAufraeumer;
  return account.provider === "gmail" ? gmailAufraeumer : hotmailAufraeumer;
}

// ─── Gemeinsame Abläufe ──────────────────────────────────────────────────────

export interface Bewertet extends AbsenderGruppe {
  urteil: "muell" | "behalten" | "unsicher";
  grund: string;
}

/**
 * Stichprobe nach Absender gruppieren, bereits entschiedene Absender auslassen und bis zu 40 neue
 * von Claude bewerten lassen. Die Urteile werden gespeichert, damit niemand zweimal gefragt wird.
 */
export async function neueAbsenderBewerten(
  account: AccountRow,
  kategorie: string,
  frist: number,
  zusaetzlichBekannt: string[] = [],
): Promise<{ bewertet: Bewertet[]; weitere: number }> {
  const a = aufraeumerFuer(account);
  const [mails, { data: bekannt }] = await Promise.all([
    a.stichprobe(account, kategorie),
    db().from("aufraeum_absender").select("adresse").eq("account_id", account.id).eq("kategorie", kategorie),
  ]);
  const schonDa = new Set([...(bekannt ?? []).map((b) => b.adresse as string), ...zusaetzlichBekannt]);
  const alle = nachAbsender(mails, 1000).filter((g) => !schonDa.has(g.adresse));
  const gruppen = alle.slice(0, 40);
  if (!gruppen.length) return { bewertet: [], weitere: 0 };

  const urteile = await muellBewerten(gruppen, a.kategorien[kategorie], frist);
  const bewertet: Bewertet[] = gruppen.map((g) => ({
    ...g,
    ...(urteile.get(g.adresse) ?? { urteil: "unsicher" as const, grund: "nicht bewertet" }),
  }));
  await db()
    .from("aufraeum_absender")
    .upsert(
      bewertet.map((b) => ({
        account_id: account.id,
        kategorie,
        adresse: b.adresse,
        name: b.name,
        beispiele: b.beispiele,
        anzahl: b.anzahl,
        urteil: b.urteil,
        grund: b.grund,
        entschieden_von: "mail",
        aktualisiert_am: new Date().toISOString(),
      })),
      { onConflict: "account_id,kategorie,adresse" },
    );
  return { bewertet, weitere: alle.length - gruppen.length };
}

/** Mails der Absender in den Papierkorb und die Anzahl je Absender nachführen. */
export async function absenderVerschieben(
  account: AccountRow,
  kategorie: string,
  adressen: string[],
  ende: number,
  von: "mail" | "sven",
): Promise<{ verschoben: number; rest: string[] }> {
  const r = await aufraeumerFuer(account).verschieben(account, kategorie, adressen, ende);
  const erledigt = adressen.filter((x) => !r.rest.includes(x));
  if (erledigt.length) {
    await db()
      .from("aufraeum_absender")
      .update({ aktualisiert_am: new Date().toISOString() })
      .eq("account_id", account.id)
      .eq("kategorie", kategorie)
      .in("adresse", erledigt);
  }
  if (r.verschoben) {
    await log(von, "aufgeraeumt", account.adresse, `${r.verschoben} Mails in den Papierkorb (${kategorie}, ${erledigt.length} Absender)`);
  }
  return r;
}
