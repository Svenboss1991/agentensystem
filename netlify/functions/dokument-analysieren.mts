import { json, nichtSven } from "../lib/auth.js";
import { db } from "../lib/db.js";
import { dokumenteAnalysieren } from "../lib/dokumentAnalyse.js";

/** Analyse anfordern: markiert das Dokument und reicht es gleich als Batch ein; das Ergebnis kommt nach einigen Minuten. */
export default async (req: Request) => {
  if (req.method !== "POST") return json(405, { fehler: "Nur POST" });
  const verweigert = await nichtSven(req);
  if (verweigert) return json(403, { fehler: `Nicht erlaubt: ${verweigert}` });

  const { dokument_id } = (await req.json().catch(() => ({}))) as { dokument_id?: string };
  const { error } = await db()
    .from("dokumente")
    .update({ analyse_status: "laeuft", analyse_fehler: null, analyse_batch: null })
    .eq("id", dokument_id ?? "");
  if (error) return json(500, { fehler: error.message });
  try {
    return json(200, { stand: await dokumenteAnalysieren() });
  } catch (err) {
    // Einreichen klappt sonst beim nächsten geplanten Lauf.
    return json(200, { stand: err instanceof Error ? err.message : String(err) });
  }
};
