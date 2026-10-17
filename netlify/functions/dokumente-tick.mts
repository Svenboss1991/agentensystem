import type { Config } from "@netlify/functions";
import { log } from "../lib/db.js";
import { dokumenteAnalysieren } from "../lib/dokumentAnalyse.js";

// Alle 2 Minuten: fertige Dokument-Analysen abholen und neue einreichen. Ohne offene Analysen endet der Lauf sofort.
export default async () => {
  try {
    const r = await dokumenteAnalysieren();
    if (r !== "nichts zu tun") console.log("Dokumente:", r);
  } catch (err) {
    await log("finanz", "dokument_analyse_fehler", null, err instanceof Error ? err.message : String(err));
  }
};

export const config: Config = { schedule: "*/2 * * * *" };
