import Anthropic from "@anthropic-ai/sdk";
import { DOKUMENT_SYSTEM, DokumentAnalyse, jsonAusText } from "./claude.js";
import { db, log } from "./db.js";
import { envOptional } from "./env.js";

// Analyse von Policen und Verträgen über die Batch-Schnittstelle: kein 30-Sekunden-Limit, halbe Kosten.
// Ablauf: Sven lädt hoch → analyse_status «laeuft» → der geplante Lauf reicht einen Batch ein → holt das Ergebnis ab.

const MODEL = envOptional("CLAUDE_MODEL") ?? "claude-opus-5-5";
let client: Anthropic | undefined;
const anthropic = () => (client ??= new Anthropic());

const istDatum = (s: string | null | undefined): s is string => /^\d{4}-\d{2}-\d{2}$/.test(s ?? "");

function tageVorher(datum: string, tage: number): string {
  const d = new Date(`${datum}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - tage);
  return d.toISOString().slice(0, 10);
}

function intervall(text: string | null | undefined): string | null {
  const t = (text ?? "").toLowerCase();
  if (/jähr|jahr|annual|year|anual/.test(t)) return t.includes("halb") || t.includes("semest") ? "halbjaehrlich" : "jaehrlich";
  if (/monat|month|mensual/.test(t)) return "monatlich";
  if (/quartal|quarter|trimest/.test(t)) return "quartalsweise";
  if (/woche|week|semanal/.test(t)) return "woechentlich";
  return null;
}

interface Dok {
  id: string;
  titel: string;
  typ: string;
  bereich: string;
  datei_pfad: string;
  mime: string | null;
  gueltig_bis: string | null;
  erinnern_am: string | null;
}

async function inhalt(d: Dok): Promise<Anthropic.Messages.ContentBlockParam> {
  const { data: datei, error } = await db().storage.from("dokumente").download(d.datei_pfad);
  if (error || !datei) throw new Error(`Datei nicht lesbar: ${error?.message ?? "leer"}`);
  const mime = d.mime || datei.type || "";
  const bytes = Buffer.from(await datei.arrayBuffer());
  if (bytes.length > 25 * 1024 * 1024) throw new Error("Datei ist zu gross für die Analyse (max. 25 MB)");
  if (mime === "application/pdf" || d.datei_pfad.toLowerCase().endsWith(".pdf")) {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") } };
  }
  if (/^image\/(png|jpeg|gif|webp)$/.test(mime)) {
    return { type: "image", source: { type: "base64", media_type: mime as "image/png", data: bytes.toString("base64") } };
  }
  if (mime.startsWith("text/")) return { type: "text", text: bytes.toString("utf8") };
  throw new Error("Nur PDF, Bilder und Textdateien können analysiert werden");
}

async function praemieAlsAbo(a: DokumentAnalyse, d: Dok): Promise<void> {
  const iv = intervall(a.praemie_intervall);
  if (!a.anbieter || a.praemie_betrag == null || !iv) return;
  const produkt = a.art ?? d.titel;
  const { data: vorhanden } = await db().from("abos").select("id").ilike("anbieter", a.anbieter).ilike("produkt", produkt).limit(1);
  const werte = {
    betrag: a.praemie_betrag,
    waehrung: a.praemie_waehrung ?? "MXN",
    intervall: iv,
    beginn: istDatum(a.beginn) ? a.beginn : null,
    laufzeit_bis: istDatum(a.ende) ? a.ende : null,
    kuendigungsfrist: a.kuendigungsfrist ?? null,
    kuendbar_bis: istDatum(a.kuendbar_bis) ? a.kuendbar_bis : null,
    aktualisiert_am: new Date().toISOString(),
  };
  if (vorhanden?.[0]) await db().from("abos").update(werte).eq("id", vorhanden[0].id);
  else await db().from("abos").insert({ anbieter: a.anbieter, produkt, bereich: d.bereich, status: "aktiv", notiz: `aus Dokument «${d.titel}»`, ...werte });
}

async function speichern(d: Dok, a: DokumentAnalyse): Promise<void> {
  const ergaenzen: Record<string, unknown> = {};
  if (!d.gueltig_bis && istDatum(a.ende)) ergaenzen.gueltig_bis = a.ende;
  if (!d.erinnern_am && istDatum(a.kuendbar_bis)) ergaenzen.erinnern_am = tageVorher(a.kuendbar_bis, 7);
  await db()
    .from("dokumente")
    .update({ auswertung: a, analyse_status: "fertig", analyse_batch: null, analyse_fehler: null, analysiert_am: new Date().toISOString(), ...ergaenzen })
    .eq("id", d.id);
  if (d.typ === "police" || d.typ === "vertrag") await praemieAlsAbo(a, d);
  await log("finanz", "dokument_analysiert", d.id, d.titel);
}

const fehler = (id: string, msg: string) =>
  db().from("dokumente").update({ analyse_status: "fehler", analyse_batch: null, analyse_fehler: msg }).eq("id", id);

/** Ein Durchgang: fertige Batches abholen, neue Analysen einreichen. */
export async function dokumenteAnalysieren(): Promise<string> {
  const { data } = await db()
    .from("dokumente")
    .select("id, titel, typ, bereich, datei_pfad, mime, gueltig_bis, erinnern_am, analyse_batch")
    .eq("analyse_status", "laeuft");
  const offen = (data ?? []) as (Dok & { analyse_batch: string | null })[];
  if (!offen.length) return "nichts zu tun";

  // 1. Laufende Batches abholen
  let fertig = 0;
  for (const batchId of new Set(offen.map((d) => d.analyse_batch).filter((b): b is string => !!b))) {
    const batch = await anthropic().messages.batches.retrieve(batchId);
    if (batch.processing_status !== "ended") continue;
    for await (const r of await anthropic().messages.batches.results(batchId)) {
      const d = offen.find((x) => x.id === r.custom_id);
      if (!d) continue;
      try {
        if (r.result.type !== "succeeded") throw new Error(`Analyse fehlgeschlagen (${r.result.type})`);
        if (r.result.message.stop_reason === "refusal") throw new Error("Claude hat die Analyse abgelehnt");
        const text = r.result.message.content
          .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        await speichern(d, jsonAusText(DokumentAnalyse, text));
        fertig++;
      } catch (err) {
        await fehler(d.id, err instanceof Error ? err.message : String(err));
      }
    }
  }

  // 2. Neue Analysen einreichen
  const neu = offen.filter((d) => !d.analyse_batch);
  const anfragen: Anthropic.Messages.Batches.BatchCreateParams.Request[] = [];
  for (const d of neu) {
    try {
      anfragen.push({
        custom_id: d.id,
        params: {
          model: MODEL,
          max_tokens: 16000,
          output_config: { effort: "low" },
          system: DOKUMENT_SYSTEM,
          messages: [{ role: "user", content: [await inhalt(d), { type: "text", text: `Titel: ${d.titel}\nTyp laut Sven: ${d.typ}\n\nBitte analysieren.` }] }],
        } as Anthropic.Messages.MessageCreateParamsNonStreaming,
      });
    } catch (err) {
      await fehler(d.id, err instanceof Error ? err.message : String(err));
    }
  }
  if (anfragen.length) {
    const batch = await anthropic().messages.batches.create({ requests: anfragen });
    await db().from("dokumente").update({ analyse_batch: batch.id }).in("id", anfragen.map((a) => a.custom_id));
  }
  return `${fertig} fertig, ${anfragen.length} eingereicht`;
}
