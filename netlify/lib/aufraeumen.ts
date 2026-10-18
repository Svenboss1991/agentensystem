import type { ImapFlow } from "imapflow";
import { istZeitproblem, muellBewerten, muellErkennen, type SvensEntscheid, nachAbsender, type AbsenderGruppe } from "./claude.js";
import { db, log, type AccountRow } from "./db.js";
import { gmail } from "./providers/gmail.js";
import { withImap } from "./providers/imap.js";
import { parseRaw } from "./providers/types.js";
import { accessToken } from "./providers/oauth.js";
import { graph } from "./providers/outlook.js";

// Aufräumen voller Postfächer. Der Agent verschiebt nur in den Papierkorb («Gelöschte Elemente»),
// nie endgültig. Markierte (Stern/Fahne) und wichtige Mails bleiben unberührt.

export interface StichprobenMail {
  /** Kennung beim Anbieter, für einzelne Mails (vorlegen, verschieben, lesen). */
  id?: string;
  datum?: string;
  adresse: string;
  name: string | null;
  betreff: string;
}

export interface BeispielMail {
  betreff: string | null;
  datum: string;
  text: string;
}

const KUERZEN = 20_000;
const kurz = (t: string, max = KUERZEN) => (t.length > max ? `${Array.from(t.slice(0, max + 1)).slice(0, max).join("")}\n[… gekürzt]` : t);

export interface Aufraeumer {
  kategorien: Record<string, string>; // key → Titel
  vorschau(account: AccountRow): Promise<{ kategorien: { key: string; titel: string; anzahl: number }[]; papierkorb: number }>;
  /** Eine Seite Mails der Kategorie ab `cursor` (null = von vorne). `naechster` ist null am Ende. */
  seite(account: AccountRow, kategorie: string, cursor: string | null): Promise<{ mails: StichprobenMail[]; naechster: string | null }>;
  /** Mails der Absender in dieser Kategorie in den Papierkorb, bis `ende`. Gibt Anzahl und noch offene Absender zurück. */
  verschieben(account: AccountRow, kategorie: string, adressen: string[], ende: number): Promise<{ verschoben: number; rest: string[] }>;
  /** Die neuesten Mails eines Absenders in dieser Kategorie, mit ganzem Text (zum Entscheiden). */
  beispiele(account: AccountRow, kategorie: string, adresse: string, max: number): Promise<BeispielMail[]>;
  /** Einzelne Mails (nach id) in den Papierkorb. */
  einzelnVerschieben(account: AccountRow, kategorie: string, ids: string[]): Promise<void>;
  /** Eine einzelne Mail ganz lesen (für Svens Prüfung). */
  mailLesen(account: AccountRow, kategorie: string, id: string): Promise<BeispielMail>;
}

const vorTagen = (t: number) => new Date(Date.now() - t * 86_400_000);

/** Müll (Werbung, erledigte Bestellungen …) wird erst gelöscht, wenn er älter als 2 Wochen ist. */
export const WERBUNG_ALT_TAGE = 14;
/** Spam darf sofort weg; sonst nur Mails, die älter als 2 Wochen sind. */
const nurAlt = (kategorie: string) => !/spam|junk/.test(kategorie);

/** «…_woche»-Kategorien laufen jeden Montag über die Mails der letzten Woche; die übrigen sind der grosse Durchgang. */
export const istWoche = (kategorie: string) => kategorie.endsWith("_woche");

// ─── Gmail ───────────────────────────────────────────────────────────────────

// Nur Mails mit Stern sind geschützt. «Wichtig» setzt Gmail selbst, auch bei viel Werbung; das hielt zu viel Müll zurück.
const G_SCHUTZ = "-is:starred";
const G_KAT: Record<string, { titel: string; q: string }> = {
  werbung: { titel: "Werbung (Tab «Werbung»)", q: `category:promotions ${G_SCHUTZ}` },
  allgemein: { titel: "Posteingang «Allgemein»", q: `category:primary ${G_SCHUTZ}` },
  sozial: { titel: "Soziale Netzwerke", q: `category:social ${G_SCHUTZ}` },
  foren: { titel: "Foren und Mailinglisten", q: `category:forums ${G_SCHUTZ}` },
  updates: { titel: "Benachrichtigungen (Tab «Updates»)", q: `category:updates ${G_SCHUTZ}` },
  spam: { titel: "Spam", q: "in:spam" },
  // Wöchentlich (Montag): die letzten gut 3 Wochen, damit jede Werbung einmal mit über 2 Wochen Alter drankommt.
  werbung_woche: { titel: "Werbung der letzten Woche", q: `category:promotions newer_than:22d ${G_SCHUTZ}` },
  sozial_woche: { titel: "Soziale Netzwerke der letzten Woche", q: `category:social newer_than:22d ${G_SCHUTZ}` },
  foren_woche: { titel: "Foren der letzten Woche", q: `category:forums newer_than:22d ${G_SCHUTZ}` },
  updates_woche: { titel: "Benachrichtigungen der letzten Woche", q: `category:updates newer_than:22d ${G_SCHUTZ}` },
  spam_woche: { titel: "Spam der letzten Woche", q: "in:spam newer_than:8d" },
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
      Object.entries(G_KAT)
        .filter(([key]) => !istWoche(key))
        .map(async ([key, k]) => ({ key, titel: k.titel, anzahl: await schaetzung(k.q) })),
    );
    return { kategorien, papierkorb: await schaetzung("in:trash") };
  },

  async seite(account, kategorie, cursor) {
    const liste = await gmail<GListe & { nextPageToken?: string }>(
      account,
      `${gPfad(G_KAT[kategorie].q, 150)}${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ""}`,
    );
    const ids = (liste.messages ?? []).map((m) => m.id);
    const mails: StichprobenMail[] = [];
    let n = 0;
    // Kopfzeilen je 10 parallel holen (Gmail erlaubt rund 6000 «Einheiten» pro Minute, eine Abfrage kostet 5).
    for (let i = 0; i < ids.length; i += 10) {
      const teil = await Promise.all(
        ids.slice(i, i + 10).map((id) =>
          gmail<{ internalDate?: string; payload?: { headers?: { name: string; value: string }[] } }>(
            account,
            `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
          ),
        ),
      );
      for (const m of teil) {
        const h = (name: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === name)?.value ?? "";
        const datum = m.internalDate ? new Date(Number(m.internalDate)).toISOString() : undefined;
        mails.push({ id: ids[n++], datum, ...absenderZerlegen(h("from")), betreff: h("subject") });
      }
    }
    return { mails, naechster: liste.nextPageToken ?? null };
  },

  async beispiele(account, kategorie, adresse, max) {
    const q = `${G_KAT[kategorie].q} from:${adresse.replace(/[^\w.@+-]/g, "")}`;
    const ids = ((await gmail<GListe>(account, gPfad(q, max))).messages ?? []).map((m) => m.id);
    return Promise.all(
      ids.map(async (id) => {
        const m = await gmail<{ raw: string; internalDate: string }>(account, `/messages/${id}?format=raw`);
        const p = await parseRaw(Buffer.from(m.raw, "base64url"), id, null, new Date(Number(m.internalDate)));
        return { betreff: p.betreff, datum: p.empfangenAm.toISOString(), text: kurz(p.text) };
      }),
    );
  },

  async verschieben(account, kategorie, adressen, ende) {
    let verschoben = 0;
    const rest = [...adressen];
    while (rest.length && Date.now() < ende) {
      const adresse = rest[0].replace(/[^\w.@+-]/g, "");
      const alt = nurAlt(kategorie) ? ` older_than:${WERBUNG_ALT_TAGE}d` : "";
      const ids = ((await gmail<GListe>(account, gPfad(`${G_KAT[kategorie].q}${alt} from:${adresse}`, 500))).messages ?? []).map((m) => m.id);
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

  async einzelnVerschieben(account, _kategorie, ids) {
    for (let i = 0; i < ids.length; i += 500) {
      await gmail(account, "/messages/batchModify", {
        method: "POST",
        body: JSON.stringify({ ids: ids.slice(i, i + 500), addLabelIds: ["TRASH"], removeLabelIds: ["INBOX", "SPAM"] }),
      });
    }
  },

  async mailLesen(account, _kategorie, id) {
    const m = await gmail<{ raw: string; internalDate: string }>(account, `/messages/${encodeURIComponent(id)}?format=raw`);
    const p = await parseRaw(Buffer.from(m.raw, "base64url"), id, null, new Date(Number(m.internalDate)));
    return { betreff: p.betreff, datum: p.empfangenAm.toISOString(), text: kurz(p.text, 20_000) };
  },
};

// ─── Hotmail (Microsoft Graph) ───────────────────────────────────────────────

const H_SCHUTZ = "flag/flagStatus ne 'flagged' and importance ne 'high'";
const H_KAT: Record<string, { titel: string; ordner: string; filter: () => string }> = {
  sonstige: {
    titel: "Posteingang «Sonstige» (Werbung, Newsletter)",
    ordner: "inbox",
    filter: () => `inferenceClassification eq 'other' and ${H_SCHUTZ}`,
  },
  relevant: {
    titel: "Posteingang «Relevant»",
    ordner: "inbox",
    filter: () => `inferenceClassification eq 'focused' and ${H_SCHUTZ}`,
  },
  archiv: {
    titel: "Archiv",
    ordner: "archive",
    filter: () => H_SCHUTZ,
  },
  junk: { titel: "Junk-E-Mail", ordner: "junkemail", filter: () => `receivedDateTime lt ${new Date().toISOString()}` },
  sonstige_woche: {
    titel: "«Sonstige» der letzten Woche",
    ordner: "inbox",
    filter: () => `inferenceClassification eq 'other' and receivedDateTime ge ${vorTagen(22).toISOString()} and ${H_SCHUTZ}`,
  },
  junk_woche: { titel: "Junk der letzten Woche", ordner: "junkemail", filter: () => `receivedDateTime ge ${vorTagen(8).toISOString()}` },
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
      Object.entries(H_KAT)
        .filter(([key]) => !istWoche(key))
        .map(async ([key, k]) => ({ key, titel: k.titel, anzahl: await zaehlen(key) })),
    );
    const g = (await (await graph(account, "/mailFolders/deleteditems?$select=totalItemCount")).json()) as { totalItemCount?: number };
    return { kategorien, papierkorb: g.totalItemCount ?? 0 };
  },

  async seite(account, kategorie, cursor) {
    // Der Cursor ist der «nextLink» von Microsoft (vollständige Adresse).
    const r = (await (await graph(account, cursor ?? hListe(kategorie, "", 500, "id,subject,from,receivedDateTime"))).json()) as {
      value: { id: string; subject?: string; receivedDateTime?: string; from?: { emailAddress?: { address?: string; name?: string } } }[];
      "@odata.nextLink"?: string;
    };
    const mails = r.value
      .filter((m) => m.from?.emailAddress?.address)
      .map((m) => ({
        id: m.id,
        datum: m.receivedDateTime,
        adresse: m.from!.emailAddress!.address!,
        name: m.from!.emailAddress!.name ?? null,
        betreff: m.subject ?? "",
      }));
    return { mails, naechster: r["@odata.nextLink"] ?? null };
  },

  async beispiele(account, kategorie, adresse, max) {
    const r = (await (
      await graph(
        account,
        `${hListe(kategorie, ` and from/emailAddress/address eq '${adresse.replace(/'/g, "''")}'`, max, "subject,body,receivedDateTime")}`,
        { headers: { Prefer: 'outlook.body-content-type="text"' } },
      )
    ).json()) as { value: { subject?: string; receivedDateTime: string; body?: { content?: string } }[] };
    return r.value.map((m) => ({ betreff: m.subject ?? null, datum: m.receivedDateTime, text: kurz(m.body?.content ?? "") }));
  },

  async verschieben(account, kategorie, adressen, ende) {
    let verschoben = 0;
    const rest = [...adressen];
    while (rest.length && Date.now() < ende) {
      const adresse = rest[0].replace(/'/g, "''");
      const alt = nurAlt(kategorie) ? ` and receivedDateTime lt ${vorTagen(WERBUNG_ALT_TAGE).toISOString()}` : "";
      const ids = (
        (await (await graph(account, hListe(kategorie, ` and from/emailAddress/address eq '${adresse}'${alt}`, 100, "id"))).json()) as {
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

  async einzelnVerschieben(account, _kategorie, ids) {
    await hVerschieben(account, ids);
  },

  async mailLesen(account, _kategorie, id) {
    const m = (await (
      await graph(account, `/messages/${encodeURIComponent(id)}?$select=subject,body,receivedDateTime`, {
        headers: { Prefer: 'outlook.body-content-type="text"' },
      })
    ).json()) as { subject?: string; receivedDateTime: string; body?: { content?: string } };
    return { betreff: m.subject ?? null, datum: m.receivedDateTime, text: kurz(m.body?.content ?? "", 20_000) };
  },
};

// ─── Hostpoint / Hostinger (IMAP) ────────────────────────────────────────────

async function ordnerMit(c: ImapFlow, specialUse: string, muster: RegExp): Promise<string | undefined> {
  const liste = await c.list();
  return liste.find((f) => f.specialUse === specialUse)?.path ?? liste.find((f) => muster.test(f.path))?.path;
}

const I_KAT: Record<string, { titel: string; ordner: (c: ImapFlow) => Promise<string | undefined>; suche: () => Record<string, unknown> }> = {
  alt: { titel: "Posteingang", ordner: async () => "INBOX", suche: () => ({ flagged: false }) },
  spam: { titel: "Spam / Junk", ordner: (c) => ordnerMit(c, "\\Junk", /(^|\.)(spam|junk)$/i), suche: () => ({ all: true }) },
  spam_woche: {
    titel: "Spam der letzten Woche",
    ordner: (c) => ordnerMit(c, "\\Junk", /(^|\.)(spam|junk)$/i),
    suche: () => ({ since: vorTagen(8) }),
  },
};
const iPapierkorb = (c: ImapFlow) => ordnerMit(c, "\\Trash", /(^|\.)(trash|papierkorb|deleted|gelöscht)/i);

const imapAufraeumer: Aufraeumer = {
  kategorien: Object.fromEntries(Object.entries(I_KAT).map(([k, v]) => [k, v.titel])),

  vorschau: (account) =>
    withImap(account, async (c) => {
      const kategorien = [];
      for (const [key, k] of Object.entries(I_KAT).filter(([key]) => !istWoche(key))) {
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

  seite: (account, kategorie, cursor) =>
    withImap(account, async (c) => {
      const pfad = await I_KAT[kategorie].ordner(c);
      if (!pfad) return { mails: [], naechster: null };
      const lock = await c.getMailboxLock(pfad);
      try {
        // Von neu nach alt; der Cursor ist die kleinste UID der letzten Seite.
        const alle = ((await c.search(I_KAT[kategorie].suche(), { uid: true })) || [])
          .filter((u) => !cursor || u < Number(cursor))
          .sort((a, b) => b - a);
        const uids = alle.slice(0, 400);
        const mails: StichprobenMail[] = [];
        if (uids.length) {
          for await (const m of c.fetch(uids, { uid: true, envelope: true, internalDate: true }, { uid: true })) {
            const von = m.envelope?.from?.[0];
            const d = m.internalDate ?? m.envelope?.date;
            if (von?.address)
              mails.push({
                id: String(m.uid),
                datum: d ? new Date(d).toISOString() : undefined,
                adresse: von.address,
                name: von.name || null,
                betreff: m.envelope?.subject ?? "",
              });
          }
        }
        return { mails, naechster: alle.length > uids.length ? String(uids[uids.length - 1]) : null };
      } finally {
        lock.release();
      }
    }),

  beispiele: (account, kategorie, adresse, max) =>
    withImap(account, async (c) => {
      const pfad = await I_KAT[kategorie].ordner(c);
      if (!pfad) return [];
      const lock = await c.getMailboxLock(pfad);
      try {
        const uids = ((await c.search({ ...I_KAT[kategorie].suche(), from: adresse }, { uid: true })) || [])
          .sort((a, b) => b - a)
          .slice(0, max);
        const mails: BeispielMail[] = [];
        if (uids.length) {
          for await (const m of c.fetch(uids, { uid: true, source: true, internalDate: true }, { uid: true })) {
            if (!m.source) continue;
            const p = await parseRaw(m.source, String(m.uid), null, m.internalDate ? new Date(m.internalDate) : undefined);
            mails.push({ betreff: p.betreff, datum: p.empfangenAm.toISOString(), text: kurz(p.text) });
          }
        }
        return mails.sort((a, b) => b.datum.localeCompare(a.datum));
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
          const alt = nurAlt(kategorie) ? { before: vorTagen(WERBUNG_ALT_TAGE) } : {};
          const uids = (await c.search({ ...I_KAT[kategorie].suche(), ...alt, from: rest[0] }, { uid: true })) || [];
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

  einzelnVerschieben: (account, kategorie, ids) =>
    withImap(account, async (c) => {
      const pfad = await I_KAT[kategorie].ordner(c);
      const ziel = await iPapierkorb(c);
      if (!pfad || !ziel) throw new Error("Papierkorb-Ordner nicht gefunden");
      const lock = await c.getMailboxLock(pfad);
      try {
        await c.messageMove(ids.map(Number), ziel, { uid: true });
      } finally {
        lock.release();
      }
    }),

  mailLesen: (account, kategorie, id) =>
    withImap(account, async (c) => {
      const pfad = await I_KAT[kategorie].ordner(c);
      if (!pfad) throw new Error("Ordner nicht gefunden");
      const lock = await c.getMailboxLock(pfad);
      try {
        const m = await c.fetchOne(id, { uid: true, source: true, internalDate: true }, { uid: true });
        if (!m || !m.source) throw new Error("Mail nicht mehr vorhanden");
        const p = await parseRaw(m.source, id, null, m.internalDate ? new Date(m.internalDate) : undefined);
        return { betreff: p.betreff, datum: p.empfangenAm.toISOString(), text: kurz(p.text, 20_000) };
      } finally {
        lock.release();
      }
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
 * Eine Seite nach Absender gruppieren, bereits entschiedene Absender auslassen und bis zu 40 neue
 * von Claude bewerten lassen. Die Urteile werden gespeichert, damit niemand zweimal gefragt wird.
 */
export async function neueAbsenderBewerten(
  account: AccountRow,
  kategorie: string,
  frist: number,
  zusaetzlichBekannt: string[] = [],
  cursor: string | null = null,
): Promise<{ bewertet: Bewertet[]; weitere: number; naechster: string | null; seitenAbsender: string[]; geprueft: number; mails: StichprobenMail[] }> {
  const a = aufraeumerFuer(account);
  const [{ mails, naechster }, { data: bekannt }] = await Promise.all([
    a.seite(account, kategorie, cursor),
    // Ein einmal beurteilter Absender gilt für alle Kategorien dieses Postfachs.
    db().from("aufraeum_absender").select("adresse").eq("account_id", account.id),
  ]);
  const schonDa = new Set([...(bekannt ?? []).map((b) => b.adresse as string), ...zusaetzlichBekannt]);
  const gruppenAlle = nachAbsender(mails, 1000);
  const seitenAbsender = gruppenAlle.map((g) => g.adresse);
  const alle = gruppenAlle.filter((g) => !schonDa.has(g.adresse));
  // Kleine Portionen, damit Claude innerhalb des Zeitlimits einer Netlify-Funktion antwortet.
  const gruppen = alle.slice(0, 15);
  if (!gruppen.length) return { bewertet: [], weitere: 0, naechster, seitenAbsender, geprueft: mails.length, mails };

  let urteile: Awaited<ReturnType<typeof muellBewerten>>;
  try {
    urteile = await muellBewerten(gruppen, a.kategorien[kategorie], frist);
  } catch (err) {
    // Zu wenig Zeit übrig: diese Absender im nächsten Schritt bewerten statt abzubrechen.
    if (istZeitproblem(err)) return { bewertet: [], weitere: alle.length, naechster, seitenAbsender, geprueft: mails.length, mails };
    throw err;
  }
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
  return { bewertet, weitere: alle.length - gruppen.length, naechster, seitenAbsender, geprueft: mails.length, mails };
}

/**
 * Ein Schritt durch alle Mails einer Kategorie (alle Jahre), seitenweise mit gespeicherter Stelle:
 * neue Absender der Seite bewerten, Müll-Absender der Seite in den Papierkorb (alle ihre Mails dieser Kategorie).
 */
export async function aufraeumSchritt(
  account: AccountRow,
  kategorie: string,
  start: number,
  von: "mail" | "sven",
): Promise<{
  verschoben: number;
  vorgelegt: number;
  muell: number;
  behalten: number;
  unsicher: number;
  geprueft: number;
  kategorieFertig: boolean;
}> {
  const { data: stand } = await db()
    .from("aufraeum_stand")
    .select("cursor, gepruefte_mails")
    .eq("account_id", account.id)
    .eq("kategorie", kategorie)
    .maybeSingle();
  const r = await neueAbsenderBewerten(account, kategorie, start + 23_000, [], stand?.cursor ?? null);

  const { data: urteile } = r.seitenAbsender.length
    ? await db()
        .from("aufraeum_absender")
        .select("adresse, urteil, entschieden_von")
        .eq("account_id", account.id)
        .in("adresse", r.seitenAbsender)
    : { data: [] };
  const muellAdressen = [...new Set((urteile ?? []).filter((u) => u.urteil === "muell").map((u) => u.adresse as string))];
  const v = await absenderVerschieben(account, kategorie, muellAdressen, start + 26_000, von);

  // Danach jede übrige Mail der Seite einzeln: Müll älter als 2 Wochen → Papierkorb, Müll jünger → später,
  // alles andere legt der Agent Sven beim grossen Durchgang vor (wöchentlich nur bei unsicheren Absendern).
  // Bereits vorgelegte oder eingestufte Mails werden nicht nochmals bewertet.
  const a = aufraeumerFuer(account);
  const urteilVon = new Map((urteile ?? []).map((u) => [u.adresse as string, u]));
  let einzeln = 0;
  let einzelnOffen = false;
  let vorgelegt = 0;
  if (r.weitere === 0 && v.rest.length === 0) {
    const kandidaten = r.mails.filter((m) => {
      const u = urteilVon.get(m.adresse.toLowerCase());
      return m.id && u?.urteil !== "muell" && !(u?.urteil === "behalten" && u.entschieden_von === "sven");
    });
    const status = await vorlageStatus(account.id, kandidaten.map((m) => m.id!));
    const istAlt = (m: StichprobenMail) => !m.datum || Date.now() - Date.parse(m.datum) > WERBUNG_ALT_TAGE * 86_400_000;
    const nunAlt = kandidaten.filter((m) => status.get(m.id!) === "jung" && istAlt(m));
    const neu = kandidaten.filter((m) => !status.has(m.id!));
    let portion = neu.slice(0, 100);
    if (neu.length > portion.length) einzelnOffen = true;
    let muellIdx = new Set<number>();
    if (portion.length && Date.now() > start + 15_000) {
      portion = [];
      einzelnOffen = true;
    } else if (portion.length) {
      try {
        muellIdx = await muellErkennen(portion, account.aufraeum_strenge ?? "normal", await svensEntscheide(account.id), start + 25_000);
      } catch (err) {
        if (!istZeitproblem(err)) throw err;
        portion = [];
        einzelnOffen = true;
      }
    }
    const weg = [...nunAlt, ...portion.filter((m, i) => muellIdx.has(i) && istAlt(m))];
    if (weg.length) {
      await a.einzelnVerschieben(account, kategorie, weg.map((m) => m.id!));
      einzeln = weg.length;
      await log(von, "aufgeraeumt", account.adresse, `${weg.length} Müll-Mails (älter als 2 Wochen) in den Papierkorb (${kategorie})`);
    }
    const zeile = (m: StichprobenMail, st: string) => ({
      account_id: account.id,
      kategorie,
      mail_id: m.id!,
      adresse: m.adresse.toLowerCase(),
      name: m.name,
      betreff: m.betreff,
      datum: m.datum ?? null,
      status: st,
    });
    const zeilen = [
      ...nunAlt.map((m) => zeile(m, "papierkorb")),
      ...portion.flatMap((m, i) => {
        if (muellIdx.has(i)) return [zeile(m, istAlt(m) ? "papierkorb" : "jung")];
        const vorlegen = !istWoche(kategorie) || urteilVon.get(m.adresse.toLowerCase())?.urteil === "unsicher";
        if (vorlegen) vorgelegt++;
        return [zeile(m, vorlegen ? "offen" : "still")];
      }),
    ];
    if (zeilen.length) {
      const { error } = await db().from("aufraeum_vorlage").upsert(zeilen, { onConflict: "account_id,mail_id" });
      if (error) throw new Error(`Vorlage speichern: ${error.message}`);
    }
  }

  // Erst weiterblättern, wenn diese Seite ganz bewertet und aufgeräumt ist. Wurde etwas weggeräumt, rücken
  // spätere Mails nach vorne: dann dieselbe Seite nochmals lesen, sonst würden Mails übersprungen.
  const seiteFertig = r.weitere === 0 && v.rest.length === 0 && !einzelnOffen;
  const weiter = seiteFertig && v.verschoben + einzeln === 0;
  const kategorieFertig = weiter && r.naechster === null;
  const jetzt = new Date().toISOString();
  const { error: standFehler } = await db()
    .from("aufraeum_stand")
    .upsert({
      account_id: account.id,
      kategorie,
      zuletzt: jetzt,
      fehler: null,
      cursor: weiter ? r.naechster : (stand?.cursor ?? null),
      gepruefte_mails: kategorieFertig ? 0 : (stand?.gepruefte_mails ?? 0) + (weiter ? r.geprueft : 0),
      ...(kategorieFertig ? { durchgang_fertig_am: jetzt } : {}),
    });
  if (standFehler) throw new Error(`Stand speichern: ${standFehler.message}`);
  return {
    verschoben: v.verschoben + einzeln,
    vorgelegt,
    muell: r.bewertet.filter((b) => b.urteil === "muell").length,
    behalten: r.bewertet.filter((b) => b.urteil === "behalten").length,
    unsicher: r.bewertet.filter((b) => b.urteil === "unsicher").length,
    geprueft: (stand?.gepruefte_mails ?? 0) + r.geprueft,
    kategorieFertig,
  };
}

/**
 * Svens letzte Entscheide über vorgelegte Mails (dieses Postfach zuerst), damit der Agent daraus lernt:
 * je bis zu 60 gelöschte und 40 behaltene.
 */
async function svensEntscheide(accountId: string): Promise<SvensEntscheid[]> {
  const holen = (status: "papierkorb" | "behalten", n: number) =>
    db()
      .from("aufraeum_vorlage")
      .select("account_id, adresse, betreff, status")
      .eq("status", status)
      .not("entschieden_am", "is", null)
      .order("entschieden_am", { ascending: false })
      .limit(n * 3);
  const [{ data: weg }, { data: bleibt }] = await Promise.all([holen("papierkorb", 60), holen("behalten", 40)]);
  const auswahl = (zeilen: typeof weg, n: number) =>
    [...(zeilen ?? [])]
      .sort((a, b) => Number(b.account_id === accountId) - Number(a.account_id === accountId))
      .slice(0, n)
      .map((z) => ({ adresse: z.adresse as string, betreff: z.betreff as string | null, urteil: z.status as SvensEntscheid["urteil"] }));
  return [...auswahl(weg, 60), ...auswahl(bleibt, 40)];
}

/** Was mit diesen Mails schon passiert ist (vorgelegt, als junger Müll erkannt …). In Portionen, Graph-IDs sind lang. */
async function vorlageStatus(accountId: string, ids: string[]): Promise<Map<string, string>> {
  const status = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 40) {
    const { data, error } = await db()
      .from("aufraeum_vorlage")
      .select("mail_id, status")
      .eq("account_id", accountId)
      .in("mail_id", ids.slice(i, i + 40));
    if (error) throw new Error(`Vorlage lesen: ${error.message}`);
    for (const d of data ?? []) status.set(d.mail_id as string, d.status as string);
  }
  return status;
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
