import type { Config } from "@netlify/functions";
import { log } from "../lib/db.js";
import { mailAgentLauf } from "../lib/mailAgent.js";

// Geplante Funktionen dürfen 30 Sekunden laufen (auch im Gratis-Abo).
// Wir hören nach 25 Sekunden auf; was nicht fertig wurde, kommt im nächsten Lauf dran.
const LAUFZEIT_MS = 25_000;

export default async () => {
  try {
    console.log("Mail-Agent:", await mailAgentLauf(Date.now() + LAUFZEIT_MS));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Mail-Agent abgebrochen:", msg);
    await log("mail", "lauf_abgebrochen", null, msg);
  }
};

export const config: Config = { schedule: "*/5 * * * *" };
