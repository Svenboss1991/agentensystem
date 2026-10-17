import type { Config } from "@netlify/functions";
import { log } from "../lib/db.js";
import { berichteBatch, briefing, kreditkartenErinnern, kurseUndLimits, ortszeit } from "../lib/finanzen.js";

// Finanz-Agent, alle 10 Minuten:
// - Kurse und Limits während der Börsenzeit (Mo–Fr 7:30–15:00, Svens Zeit) und einmal frühmorgens
// - Berichte je Wertpapier über die Batch-Schnittstelle einreichen bzw. abholen (täglich neu)
// - Kreditkarten: Erinnerung 3 Tage vor der Zahlungsfrist
// - Briefing ab 7:50 Uhr, einmal pro Tag
export default async () => {
  const start = Date.now();
  const { stunde, minute, wochentag } = ortszeit();
  const minuten = stunde * 60 + minute;
  const werktag = wochentag >= 1 && wochentag <= 5;
  const meldungen: string[] = [];

  try {
    if ((werktag && minuten >= 7 * 60 + 30 && minuten <= 15 * 60) || (minuten >= 7 * 60 + 40 && minuten < 7 * 60 + 50)) {
      meldungen.push(`${await kurseUndLimits()} Kurse`);
    }
    meldungen.push(await berichteBatch());
    const karten = await kreditkartenErinnern();
    if (karten) meldungen.push(`${karten} Kreditkarten-Erinnerungen`);
    if (minuten >= 7 * 60 + 50 && minuten < 12 * 60) meldungen.push(await briefing(start + 25_000));
    console.log("Finanzen:", meldungen.join(" · "));
  } catch (err) {
    await log("finanz", "fehler", null, err instanceof Error ? err.message : String(err));
  }
};

export const config: Config = { schedule: "*/10 * * * *" };
