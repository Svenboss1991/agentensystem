import { json, nichtSven } from "../lib/auth.js";
import { dokumentAnalysieren, istZeitproblem, type DokumentAnalyse } from "../lib/claude.js";
import { db, log } from "../lib/db.js";

// Police oder Vertrag von Claude lesen lassen: Deckung, Ausschlüsse, Prämie, Fristen.
// Leere Felder des Dokuments (gültig bis, Erinnerung) werden ergänzt; eine wiederkehrende Prämie kommt in die Abo-Liste.

const istDatum = (s: string | null | undefined): s is string => /^\d{4}-\d{2}-\d{2}$/.test(s ?? "");

function tageVorher(datum: string, tage: number): string {
  const d = new Date(`${datum}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - tage);
  return d.toISOString().slice(0, 10);
}

function intervall(text: string | null): string | null {
  const t = (text ?? "").toLowerCase();
  if (/jähr|jahr|annual|year/.test(t)) return t.includes("halb") ? "halbjaehrlich" : "jaehrlich";
  if (/monat|month/.test(t)) return "monatlich";
  if (/quartal|quarter/.test(t)) return "quartalsweise";
  if (/woche|week/.test(t)) return "woechentlich";
  return null;
}

async function praemieAlsAbo(a: DokumentAnalyse, bereich: string, dokumentTitel: string): Promise<void> {
  const iv = intervall(a.praemie?.intervall ?? null);
  if (!a.anbieter || a.praemie?.betrag == null || !iv) return;
  const { data: vorhanden } = await db().from("abos").select("id").ilike("anbieter", a.anbieter).ilike("produkt", a.art ?? dokumentTitel).limit(1);
  const werte = {
    betrag: a.praemie.betrag,
    waehrung: a.praemie.waehrung ?? "CHF",
    intervall: iv,
    beginn: istDatum(a.beginn) ? a.beginn : null,
    laufzeit_bis: istDatum(a.ende) ? a.ende : null,
    kuendigungsfrist: a.kuendigungsfrist,
    kuendbar_bis: istDatum(a.kuendbar_bis) ? a.kuendbar_bis : null,
    aktualisiert_am: new Date().toISOString(),
  };
  if (vorhanden?.[0]) await db().from("abos").update(werte).eq("id", vorhanden[0].id);
  else
    await db()
      .from("abos")
      .insert({ anbieter: a.anbieter, produkt: a.art ?? dokumentTitel, bereich, status: "aktiv", notiz: `aus Dokument «${dokumentTitel}»`, ...werte });
}

export default async (req: Request) => {
  if (req.method !== "POST") return json(405, { fehler: "Nur POST" });
  const verweigert = await nichtSven(req);
  if (verweigert) return json(403, { fehler: `Nicht erlaubt: ${verweigert}` });

  const start = Date.now();
  const { dokument_id } = (await req.json().catch(() => ({}))) as { dokument_id?: string };
  const { data: dok } = await db()
    .from("dokumente")
    .select("id, titel, typ, bereich, datei_pfad, mime, gueltig_bis, erinnern_am")
    .eq("id", dokument_id ?? "")
    .maybeSingle();
  if (!dok) return json(404, { fehler: "Dokument nicht gefunden" });

  await db().from("dokumente").update({ analyse_status: "laeuft", analyse_fehler: null }).eq("id", dok.id);
  try {
    const { data: datei, error } = await db().storage.from("dokumente").download(dok.datei_pfad);
    if (error || !datei) throw new Error(`Datei nicht lesbar: ${error?.message ?? "leer"}`);
    const mime = dok.mime || datei.type || "";
    const bytes = Buffer.from(await datei.arrayBuffer());
    if (bytes.length > 25 * 1024 * 1024) throw new Error("Datei ist zu gross für die Analyse (max. 25 MB)");

    const inhalt =
      mime === "application/pdf" || dok.datei_pfad.toLowerCase().endsWith(".pdf")
        ? ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") } } as const)
        : /^image\/(png|jpeg|gif|webp)$/.test(mime)
          ? ({ type: "image", source: { type: "base64", media_type: mime as "image/png", data: bytes.toString("base64") } } as const)
          : mime.startsWith("text/")
            ? ({ type: "text", text: bytes.toString("utf8") } as const)
            : null;
    if (!inhalt) throw new Error("Nur PDF, Bilder und Textdateien können analysiert werden");

    const analyse = await dokumentAnalysieren(inhalt, dok.titel, dok.typ, start + 26_000);

    const ergaenzen: Record<string, unknown> = {};
    if (!dok.gueltig_bis && istDatum(analyse.ende)) ergaenzen.gueltig_bis = analyse.ende;
    if (!dok.erinnern_am && istDatum(analyse.kuendbar_bis)) ergaenzen.erinnern_am = tageVorher(analyse.kuendbar_bis, 7);
    await db()
      .from("dokumente")
      .update({ analyse, analyse_status: "fertig", analysiert_am: new Date().toISOString(), ...ergaenzen })
      .eq("id", dok.id);
    if (dok.typ === "police" || dok.typ === "vertrag") await praemieAlsAbo(analyse, dok.bereich, dok.titel);
    await log("sven", "dokument_analysiert", dok.id, dok.titel);
    return json(200, { analyse });
  } catch (err) {
    const msg = istZeitproblem(err)
      ? "Die Analyse hat zu lange gedauert. Bitte nochmals versuchen."
      : err instanceof Error
        ? err.message
        : String(err);
    await db().from("dokumente").update({ analyse_status: "fehler", analyse_fehler: msg }).eq("id", dok.id);
    return json(500, { fehler: msg });
  }
};
