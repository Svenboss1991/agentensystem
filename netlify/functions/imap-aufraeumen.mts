import type { ImapFlow } from "imapflow";
import { json, nichtSven } from "../lib/auth.js";
import { istZeitproblem, muellBewerten, nachAbsender } from "../lib/claude.js";
import { db, log, type AccountRow } from "../lib/db.js";
import { withImap } from "../lib/providers/imap.js";

// Aufräumen der Postfächer bei Hostpoint/Hostinger, nur auf Svens Klick (wie Gmail/Hotmail):
// Vorschau → Claude prüft je Absender «Müll» oder «behalten» → nur Angehaktes in den Papierkorb.
// Der Agent löscht nichts endgültig. Markierte Mails (Fahne/Stern) bleiben unberührt.

const vorTagen = (t: number) => new Date(Date.now() - t * 86_400_000);

interface Kategorie {
  titel: string;
  ordner: (c: ImapFlow) => Promise<string | undefined>;
  suche: Record<string, unknown>;
}

async function ordnerMit(c: ImapFlow, specialUse: string, muster: RegExp): Promise<string | undefined> {
  const liste = await c.list();
  return liste.find((f) => f.specialUse === specialUse)?.path ?? liste.find((f) => muster.test(f.path))?.path;
}

const KATEGORIEN: Record<string, Kategorie> = {
  alt: {
    titel: "Posteingang, älter als 1 Jahr",
    ordner: async () => "INBOX",
    suche: { before: vorTagen(365), flagged: false },
  },
  spam: {
    titel: "Spam / Junk",
    ordner: (c) => ordnerMit(c, "\\Junk", /(^|\.)(spam|junk)$/i),
    suche: { all: true },
  },
};

const papierkorb = (c: ImapFlow) => ordnerMit(c, "\\Trash", /(^|\.)(trash|papierkorb|deleted|gelöscht)/i);
const ZEITBUDGET_MS = 20_000;
const STICHPROBE = 400;

export default async (req: Request) => {
  if (req.method !== "POST") return json(405, { fehler: "Nur POST" });
  const verweigert = await nichtSven(req);
  if (verweigert) return json(403, { fehler: `Nicht erlaubt: ${verweigert}` });

  const start = Date.now();
  const { aktion, account_id, kategorie = "", absender = [], bekannt = [] } = (await req.json().catch(() => ({}))) as {
    aktion?: string;
    account_id?: string;
    kategorie?: string;
    absender?: string[];
    bekannt?: string[];
  };
  const { data: account } = await db().from("accounts").select("*").eq("id", account_id ?? "").eq("typ", "imap").maybeSingle<AccountRow>();
  if (!account) return json(400, { fehler: "Postfach nicht gefunden" });

  try {
    if (aktion === "vorschau") {
      return json(
        200,
        await withImap(account, async (c) => {
          const kategorien = [];
          for (const [key, k] of Object.entries(KATEGORIEN)) {
            const pfad = await k.ordner(c);
            let anzahl = 0;
            if (pfad) {
              const lock = await c.getMailboxLock(pfad);
              try {
                anzahl = ((await c.search(k.suche, { uid: true })) || []).length;
              } finally {
                lock.release();
              }
            }
            kategorien.push({ key, titel: k.titel, anzahl });
          }
          const pk = await papierkorb(c);
          const st = pk ? await c.status(pk, { messages: true }) : false;
          const imPapierkorb = st ? (st.messages ?? 0) : 0;
          return { kategorien, papierkorb: imPapierkorb };
        }),
      );
    }

    const k = KATEGORIEN[kategorie];
    if (!k) return json(400, { fehler: "Unbekannte Kategorie" });

    if (aktion === "analyse") {
      const mails = await withImap(account, async (c) => {
        const pfad = await k.ordner(c);
        if (!pfad) return [];
        const lock = await c.getMailboxLock(pfad);
        try {
          const uids = ((await c.search(k.suche, { uid: true })) || []).sort((a, b) => b - a).slice(0, STICHPROBE);
          const liste: { adresse: string; name: string | null; betreff: string }[] = [];
          if (uids.length) {
            for await (const m of c.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
              const von = m.envelope?.from?.[0];
              if (von?.address) liste.push({ adresse: von.address, name: von.name || null, betreff: m.envelope?.subject ?? "" });
            }
          }
          return liste;
        } finally {
          lock.release();
        }
      });
      // Pro Durchgang höchstens 40 Absender, damit Claude innerhalb des Zeitlimits antwortet.
      const alle = nachAbsender(mails, 1000).filter((g) => !bekannt.includes(g.adresse));
      const gruppen = alle.slice(0, 40);
      const urteile = gruppen.length ? await muellBewerten(gruppen, k.titel, start + 26_000) : new Map();
      return json(200, {
        stichprobe: mails.length,
        weitere: alle.length - gruppen.length,
        absender: gruppen.map((g) => ({ ...g, ...(urteile.get(g.adresse) ?? { urteil: "behalten", grund: "nicht bewertet" }) })),
      });
    }

    if (aktion === "papierkorb") {
      const ergebnis = await withImap(account, async (c) => {
        const pfad = await k.ordner(c);
        const ziel = await papierkorb(c);
        if (!pfad || !ziel) throw new Error("Papierkorb-Ordner nicht gefunden");
        let verschoben = 0;
        const rest = [...absender];
        const lock = await c.getMailboxLock(pfad);
        try {
          while (rest.length && Date.now() < start + ZEITBUDGET_MS) {
            const uids = (await c.search({ ...k.suche, from: rest[0] }, { uid: true })) || [];
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
      });
      await log("sven", "imap_papierkorb", account.adresse, `${ergebnis.verschoben} Mails (${kategorie})`);
      return json(200, ergebnis);
    }

    return json(400, { fehler: "Unbekannte Aktion" });
  } catch (err) {
    if (istZeitproblem(err)) return json(504, { fehler: "Die Prüfung hat zu lange gedauert, bitte nochmals versuchen" });
    return json(500, { fehler: err instanceof Error ? err.message : String(err) });
  }
};
