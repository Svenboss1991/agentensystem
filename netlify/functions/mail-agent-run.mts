import { json, nichtSven } from "../lib/auth.js";
import { log } from "../lib/db.js";
import { mailAgentLauf } from "../lib/mailAgent.js";

/** Knopf «Aktualisieren» auf der Seite «Heute»: einen Durchlauf sofort starten, statt auf den 5-Minuten-Takt zu warten. */
export default async (req: Request) => {
  if (req.method !== "POST") return json(405, { fehler: "Nur POST" });
  const verweigert = await nichtSven(req);
  if (verweigert) return json(403, { fehler: `Nicht erlaubt: ${verweigert}` });
  try {
    const ergebnis = await mailAgentLauf(Date.now() + 22_000);
    await log("sven", "manuell_abgerufen", null, ergebnis);
    return json(200, { ergebnis });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log("mail", "lauf_abgebrochen", null, msg);
    return json(500, { fehler: msg });
  }
};
