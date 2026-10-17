import { json, nichtSven } from "../lib/auth.js";
import { db, log, type AccountRow } from "../lib/db.js";
import { gmail } from "../lib/providers/gmail.js";

// Aufräumen eines vollen Gmail-Kontos, nur auf Svens Klick:
// 1. «vorschau»: wie viele Mails je Kategorie betroffen wären
// 2. «papierkorb»: gewählte Kategorien in den Papierkorb verschieben
// Der Agent löscht nichts endgültig: Gmail leert den Papierkorb nach 30 Tagen,
// oder Sven leert ihn selbst in Gmail. Markierte und wichtige Mails bleiben unberührt.

const SCHUTZ = "-is:starred -is:important";

const KATEGORIEN: Record<string, { titel: string; q: string }> = {
  werbung: { titel: "Werbung (Tab «Werbung»), älter als 30 Tage", q: `category:promotions older_than:30d ${SCHUTZ}` },
  sozial: { titel: "Soziale Netzwerke, älter als 30 Tage", q: `category:social older_than:30d ${SCHUTZ}` },
  foren: { titel: "Foren und Mailinglisten, älter als 30 Tage", q: `category:forums older_than:30d ${SCHUTZ}` },
  updates: { titel: "Benachrichtigungen (Tab «Updates»), älter als 1 Jahr", q: `category:updates older_than:1y ${SCHUTZ}` },
  gross: { titel: "Grosse Mails über 10 MB, älter als 2 Jahre", q: `larger:10M older_than:2y ${SCHUTZ}` },
  spam: { titel: "Spam", q: "in:spam" },
};

const ZEITBUDGET_MS = 20_000;

interface Liste {
  messages?: { id: string }[];
  resultSizeEstimate?: number;
}

const pfad = (q: string, max: number) =>
  `/messages?q=${encodeURIComponent(q)}&maxResults=${max}&includeSpamTrash=${/in:(spam|trash)/.test(q)}`;

export default async (req: Request) => {
  if (req.method !== "POST") return json(405, { fehler: "Nur POST" });
  const verweigert = await nichtSven(req);
  if (verweigert) return json(403, { fehler: `Nicht erlaubt: ${verweigert}` });

  const { aktion, kategorien = [] } = (await req.json().catch(() => ({}))) as { aktion?: string; kategorien?: string[] };
  const { data: account } = await db()
    .from("accounts")
    .select("*")
    .eq("provider", "gmail")
    .eq("aktiv", true)
    .limit(1)
    .maybeSingle<AccountRow>();
  if (!account) return json(400, { fehler: "Gmail ist noch nicht verbunden" });

  try {
    if (aktion === "vorschau") {
      const schaetzung = async (q: string) => (await gmail<Liste>(account, pfad(q, 1))).resultSizeEstimate ?? 0;
      const liste = await Promise.all(
        Object.entries(KATEGORIEN).map(async ([key, k]) => ({ key, titel: k.titel, anzahl: await schaetzung(k.q) })),
      );
      return json(200, { kategorien: liste, papierkorb: await schaetzung("in:trash") });
    }

    if (aktion === "papierkorb") {
      // In Portionen, damit ein Aufruf unter dem Zeitlimit bleibt; die Seite ruft wieder auf, bis «fertig».
      const ende = Date.now() + ZEITBUDGET_MS;
      let verschoben = 0;
      let fertig = true;
      for (const key of kategorien.filter((k) => KATEGORIEN[k])) {
        while (fertig) {
          if (Date.now() > ende) {
            fertig = false;
            break;
          }
          const ids = ((await gmail<Liste>(account, pfad(KATEGORIEN[key].q, 500))).messages ?? []).map((m) => m.id);
          if (!ids.length) break;
          await gmail(account, "/messages/batchModify", {
            method: "POST",
            body: JSON.stringify({ ids, addLabelIds: ["TRASH"], removeLabelIds: ["INBOX", "SPAM"] }),
          });
          verschoben += ids.length;
        }
      }
      await log("sven", "gmail_papierkorb", account.adresse, `${verschoben} Mails in den Papierkorb (${kategorien.join(", ")})`);
      return json(200, { verschoben, fertig });
    }

    return json(400, { fehler: "Unbekannte Aktion" });
  } catch (err) {
    return json(500, { fehler: err instanceof Error ? err.message : String(err) });
  }
};
