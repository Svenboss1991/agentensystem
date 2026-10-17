import { json, nichtSven } from "../lib/auth.js";
import { istZeitproblem, muellBewerten, nachAbsender } from "../lib/claude.js";
import { db, log, type AccountRow } from "../lib/db.js";
import { gmail } from "../lib/providers/gmail.js";

// Aufräumen eines vollen Gmail-Kontos, nur auf Svens Klick:
// 1. «vorschau»: wie viele Mails je Kategorie
// 2. «analyse»: Stichprobe einer Kategorie nach Absender gruppieren; Claude prüft je Absender «Müll» oder «behalten»
// 3. «papierkorb»: nur die Mails der von Sven angehakten Absender in dieser Kategorie in den Papierkorb
// Der Agent löscht nichts endgültig. Mails mit Stern oder «wichtig» bleiben unberührt.

const SCHUTZ = "-is:starred -is:important";

const KATEGORIEN: Record<string, { titel: string; q: string }> = {
  werbung: { titel: "Werbung (Tab «Werbung»), älter als 30 Tage", q: `category:promotions older_than:30d ${SCHUTZ}` },
  sozial: { titel: "Soziale Netzwerke, älter als 30 Tage", q: `category:social older_than:30d ${SCHUTZ}` },
  foren: { titel: "Foren und Mailinglisten, älter als 30 Tage", q: `category:forums older_than:30d ${SCHUTZ}` },
  updates: { titel: "Benachrichtigungen (Tab «Updates»), älter als 1 Jahr", q: `category:updates older_than:1y ${SCHUTZ}` },
  gross: { titel: "Grosse Mails über 10 MB, älter als 2 Jahre", q: `larger:10M older_than:2y ${SCHUTZ}` },
  spam: { titel: "Spam", q: "in:spam" },
};

const STICHPROBE = 300;
const ZEITBUDGET_MS = 20_000;

interface Liste {
  messages?: { id: string }[];
  resultSizeEstimate?: number;
}

const pfad = (q: string, max: number) =>
  `/messages?q=${encodeURIComponent(q)}&maxResults=${max}&includeSpamTrash=${/in:(spam|trash)/.test(q)}`;

function absenderZerlegen(from: string): { adresse: string; name: string | null } {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  return m ? { adresse: m[2].trim(), name: m[1].trim() || null } : { adresse: from.trim(), name: null };
}

/** Kopfzeilen vieler Mails parallel holen (je 25 gleichzeitig). */
async function kopfzeilen(account: AccountRow, ids: string[]) {
  const ergebnis: { adresse: string; name: string | null; betreff: string }[] = [];
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
      ergebnis.push({ ...absenderZerlegen(h("from")), betreff: h("subject") });
    }
  }
  return ergebnis;
}

export default async (req: Request) => {
  if (req.method !== "POST") return json(405, { fehler: "Nur POST" });
  const verweigert = await nichtSven(req);
  if (verweigert) return json(403, { fehler: `Nicht erlaubt: ${verweigert}` });

  const start = Date.now();
  const { aktion, kategorie = "", absender = [], bekannt = [] } = (await req.json().catch(() => ({}))) as {
    aktion?: string;
    kategorie?: string;
    absender?: string[];
    bekannt?: string[];
  };
  const { data: account } = await db()
    .from("accounts")
    .select("*")
    .eq("provider", "gmail")
    .eq("aktiv", true)
    .limit(1)
    .maybeSingle<AccountRow>();
  if (!account) return json(400, { fehler: "Gmail ist noch nicht verbunden" });

  const ende = Date.now() + ZEITBUDGET_MS;
  try {
    if (aktion === "vorschau") {
      const schaetzung = async (q: string) => (await gmail<Liste>(account, pfad(q, 1))).resultSizeEstimate ?? 0;
      const liste = await Promise.all(
        Object.entries(KATEGORIEN).map(async ([key, k]) => ({ key, titel: k.titel, anzahl: await schaetzung(k.q) })),
      );
      return json(200, { kategorien: liste, papierkorb: await schaetzung("in:trash") });
    }

    const k = KATEGORIEN[kategorie];
    if (!k) return json(400, { fehler: "Unbekannte Kategorie" });

    if (aktion === "analyse") {
      const ids = ((await gmail<Liste>(account, pfad(k.q, STICHPROBE))).messages ?? []).map((m) => m.id);
      // Pro Durchgang höchstens 40 Absender, damit Claude innerhalb des Zeitlimits antwortet.
      const alle = nachAbsender(await kopfzeilen(account, ids), 1000).filter((g) => !bekannt.includes(g.adresse));
      const gruppen = alle.slice(0, 40);
      const urteile = gruppen.length ? await muellBewerten(gruppen, k.titel, start + 26_000) : new Map();
      return json(200, {
        stichprobe: ids.length,
        weitere: alle.length - gruppen.length,
        absender: gruppen.map((g) => ({ ...g, ...(urteile.get(g.adresse) ?? { urteil: "behalten", grund: "nicht bewertet" }) })),
      });
    }

    if (aktion === "papierkorb") {
      // Absender nacheinander; was im Zeitbudget nicht fertig wird, kommt als «rest» zurück.
      let verschoben = 0;
      const rest = [...absender];
      while (rest.length) {
        if (Date.now() > ende) break;
        const adresse = rest[0].replace(/[^\w.@+-]/g, "");
        const ids = ((await gmail<Liste>(account, pfad(`${k.q} from:${adresse}`, 500))).messages ?? []).map((m) => m.id);
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
      await log("sven", "gmail_papierkorb", account.adresse, `${verschoben} Mails (${kategorie}, ${absender.length - rest.length} Absender)`);
      return json(200, { verschoben, rest });
    }

    return json(400, { fehler: "Unbekannte Aktion" });
  } catch (err) {
    if (istZeitproblem(err)) return json(504, { fehler: "Die Prüfung hat zu lange gedauert, bitte nochmals versuchen" });
    return json(500, { fehler: err instanceof Error ? err.message : String(err) });
  }
};
