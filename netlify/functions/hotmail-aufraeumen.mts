import { json, nichtSven } from "../lib/auth.js";
import { istZeitproblem, muellBewerten, nachAbsender } from "../lib/claude.js";
import { db, log, type AccountRow } from "../lib/db.js";
import { accessToken } from "../lib/providers/oauth.js";
import { graph } from "../lib/providers/outlook.js";

// Aufräumen des Hotmail-Postfachs, nur auf Svens Klick:
// 1. «vorschau»: wie viele Mails je Kategorie
// 2. «analyse»: Stichprobe nach Absender gruppieren; Claude prüft je Absender «Müll» oder «behalten»
// 3. «papierkorb»: nur Mails der angehakten Absender nach «Gelöschte Elemente» (zurückholbar)
// Der Agent löscht nichts endgültig. Mails mit Fahne oder hoher Wichtigkeit bleiben unberührt.

const tageZurueck = (t: number) => new Date(Date.now() - t * 86_400_000).toISOString();
const SCHUTZ = "flag/flagStatus ne 'flagged' and importance ne 'high'";

interface Kategorie {
  titel: string;
  ordner: string;
  filter: () => string;
}

const KATEGORIEN: Record<string, Kategorie> = {
  sonstige: {
    titel: "Posteingang «Sonstige» (Werbung, Newsletter), älter als 30 Tage",
    ordner: "inbox",
    filter: () => `inferenceClassification eq 'other' and receivedDateTime lt ${tageZurueck(30)} and ${SCHUTZ}`,
  },
  alt_anhaenge: {
    titel: "Mails mit Anhang, älter als 2 Jahre",
    ordner: "inbox",
    filter: () => `hasAttachments eq true and receivedDateTime lt ${tageZurueck(730)} and ${SCHUTZ}`,
  },
  junk: { titel: "Junk-E-Mail", ordner: "junkemail", filter: () => `receivedDateTime lt ${tageZurueck(0)}` },
};

const STICHPROBE = 500;
const ZEITBUDGET_MS = 20_000;

const liste = (k: Kategorie, filterZusatz: string, top: number, felder: string, zaehlen = false) =>
  `/mailFolders/${k.ordner}/messages?$filter=${encodeURIComponent(k.filter() + filterZusatz)}&$top=${top}&$select=${felder}${zaehlen ? "&$count=true" : ""}`;

interface GraphMail {
  id: string;
  subject?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
}

/** Bis zu 20 Mails pro Sammelanfrage nach «Gelöschte Elemente» verschieben. Gibt die Anzahl Erfolge zurück. */
async function verschieben(account: AccountRow, ids: string[]): Promise<number> {
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
    .eq("provider", "hotmail")
    .eq("aktiv", true)
    .limit(1)
    .maybeSingle<AccountRow>();
  if (!account) return json(400, { fehler: "Hotmail ist noch nicht verbunden" });

  try {
    if (aktion === "vorschau") {
      const zaehlen = async (k: Kategorie) => {
        const r = await graph(account, liste(k, "", 1, "id", true), { headers: { ConsistencyLevel: "eventual" } });
        return ((await r.json()) as { "@odata.count"?: number })["@odata.count"] ?? 0;
      };
      const kat = await Promise.all(
        Object.entries(KATEGORIEN).map(async ([key, k]) => ({ key, titel: k.titel, anzahl: await zaehlen(k) })),
      );
      const geloescht = (await (await graph(account, "/mailFolders/deleteditems?$select=totalItemCount")).json()) as {
        totalItemCount?: number;
      };
      return json(200, { kategorien: kat, papierkorb: geloescht.totalItemCount ?? 0 });
    }

    const k = KATEGORIEN[kategorie];
    if (!k) return json(400, { fehler: "Unbekannte Kategorie" });

    if (aktion === "analyse") {
      const mails = ((await (await graph(account, liste(k, "", STICHPROBE, "id,subject,from"))).json()) as { value: GraphMail[] })
        .value;
      const alle = nachAbsender(
        mails
          .filter((m) => m.from?.emailAddress?.address)
          .map((m) => ({ adresse: m.from!.emailAddress!.address!, name: m.from!.emailAddress!.name ?? null, betreff: m.subject ?? "" })),
        1000,
      ).filter((g) => !bekannt.includes(g.adresse));
      // Pro Durchgang höchstens 40 Absender, damit Claude innerhalb des Zeitlimits antwortet.
      const gruppen = alle.slice(0, 40);
      const urteile = gruppen.length ? await muellBewerten(gruppen, k.titel, start + 26_000) : new Map();
      return json(200, {
        stichprobe: mails.length,
        weitere: alle.length - gruppen.length,
        absender: gruppen.map((g) => ({ ...g, ...(urteile.get(g.adresse) ?? { urteil: "behalten", grund: "nicht bewertet" }) })),
      });
    }

    if (aktion === "papierkorb") {
      const ende = start + ZEITBUDGET_MS;
      let verschoben = 0;
      const rest = [...absender];
      while (rest.length) {
        if (Date.now() > ende) break;
        const adresse = rest[0].replace(/'/g, "''");
        const ids = ((await (await graph(account, liste(k, ` and from/emailAddress/address eq '${adresse}'`, 100, "id"))).json()) as {
          value: { id: string }[];
        }).value.map((m) => m.id);
        if (!ids.length) {
          rest.shift();
          continue;
        }
        const n = await verschieben(account, ids);
        // Nichts verschoben: diesen Absender überspringen statt endlos neu zu versuchen.
        if (n === 0) rest.shift();
        verschoben += n;
      }
      await log("sven", "hotmail_papierkorb", account.adresse, `${verschoben} Mails (${kategorie}, ${absender.length - rest.length} Absender)`);
      return json(200, { verschoben, rest });
    }

    return json(400, { fehler: "Unbekannte Aktion" });
  } catch (err) {
    if (istZeitproblem(err)) return json(504, { fehler: "Die Prüfung hat zu lange gedauert, bitte nochmals versuchen" });
    return json(500, { fehler: err instanceof Error ? err.message : String(err) });
  }
};
