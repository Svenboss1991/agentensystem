import { json, nichtSven } from "../lib/auth.js";
import { db, log, type AccountRow } from "../lib/db.js";
import { accessToken } from "../lib/providers/oauth.js";
import { graph } from "../lib/providers/outlook.js";

// Aufräumen des Hotmail-Postfachs, nur auf Svens Klick:
// 1. «vorschau»: wie viele Mails je Kategorie betroffen wären
// 2. «papierkorb»: gewählte Kategorien nach «Gelöschte Elemente» verschieben (zurückholbar)
// Der Agent löscht nichts endgültig. Markierte (Fahne) und wichtige Mails bleiben unberührt.

const tageZurueck = (t: number) => new Date(Date.now() - t * 86_400_000).toISOString();
const SCHUTZ = "flag/flagStatus ne 'flagged' and importance ne 'high'";

const KATEGORIEN: Record<string, { titel: string; ordner: string; filter: () => string }> = {
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

const ZEITBUDGET_MS = 20_000;

const liste = (k: { ordner: string; filter: () => string }, top: number, zaehlen = false) =>
  `/mailFolders/${k.ordner}/messages?$filter=${encodeURIComponent(k.filter())}&$top=${top}&$select=id${zaehlen ? "&$count=true" : ""}`;

export default async (req: Request) => {
  if (req.method !== "POST") return json(405, { fehler: "Nur POST" });
  const verweigert = await nichtSven(req);
  if (verweigert) return json(403, { fehler: `Nicht erlaubt: ${verweigert}` });

  const { aktion, kategorien = [] } = (await req.json().catch(() => ({}))) as { aktion?: string; kategorien?: string[] };
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
      const zaehlen = async (k: { ordner: string; filter: () => string }) => {
        const r = await graph(account, liste(k, 1, true), { headers: { ConsistencyLevel: "eventual" } });
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

    if (aktion === "papierkorb") {
      // In Portionen (je 20 Verschiebungen pro Sammelanfrage), damit ein Aufruf unter dem Zeitlimit bleibt.
      const ende = Date.now() + ZEITBUDGET_MS;
      let verschoben = 0;
      let fertig = true;
      for (const key of kategorien.filter((k) => KATEGORIEN[k])) {
        while (fertig) {
          if (Date.now() > ende) {
            fertig = false;
            break;
          }
          const ids = ((await (await graph(account, liste(KATEGORIEN[key], 100))).json()) as { value: { id: string }[] }).value.map(
            (m) => m.id,
          );
          if (!ids.length) break;
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
            const antworten = ((await r.json()) as { responses: { status: number }[] }).responses;
            erfolgreich += antworten.filter((x) => x.status < 300).length;
          }
          // Nichts verschoben: abbrechen statt dieselben Mails endlos neu zu versuchen.
          if (erfolgreich === 0) throw new Error("Hotmail hat das Verschieben abgelehnt");
          verschoben += erfolgreich;
        }
      }
      await log("sven", "hotmail_papierkorb", account.adresse, `${verschoben} Mails nach «Gelöschte Elemente» (${kategorien.join(", ")})`);
      return json(200, { verschoben, fertig });
    }

    return json(400, { fehler: "Unbekannte Aktion" });
  } catch (err) {
    return json(500, { fehler: err instanceof Error ? err.message : String(err) });
  }
};
