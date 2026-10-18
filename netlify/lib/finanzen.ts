import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { briefingSchreiben, sauber } from "./claude.js";
import { db, log } from "./db.js";
import { envOptional } from "./env.js";

// Finanz-Agent: Kurse (Yahoo Finance), Limits, Warnungen, Berichte je Wertpapier (Claude mit Websuche,
// über die Batch-Schnittstelle ohne Zeitlimit) und das tägliche Briefing. Er führt nie Aufträge aus.

const ZEITZONE = "America/Bahia_Banderas";
const MODEL = envOptional("CLAUDE_MODEL") ?? "claude-opus-5-5";
const WARNSCHWELLE = 0.08; // ±8 % an einem Tag

interface ProduktDaten {
  basiswert?: string;
  startkurs?: number;
  stichtag?: string;
  basis_kurs?: number;
  termine?: { datum: string; text: string }[];
}

function produktZeile(w: Wertpapier): string | null {
  const p = w.produkt as ProduktDaten | null;
  if (!p?.startkurs) return null;
  const naechster = (p.termine ?? []).filter((t) => t.datum >= heute()).sort((a, b) => a.datum.localeCompare(b.datum))[0];
  return `  Strukturiertes Produkt auf ${p.basiswert}: Startkurs ${p.startkurs}, aktuell ${p.basis_kurs ?? "?"}, Stichtag ${p.stichtag}${naechster ? `, nächster Termin ${naechster.datum}: ${naechster.text}` : ""}`;
}

export interface Wertpapier {
  id: string;
  emisora: string;
  name: string | null;
  typ: string;
  waehrung: string;
  ticker: string | null;
  kurs: number | null;
  kurs_vortag: number | null;
  kurs_am: string | null;
  bericht: Bericht | null;
  bericht_am: string | null;
  warnung_am: string | null;
  produkt: unknown;
}

export const heute = () => new Intl.DateTimeFormat("en-CA", { timeZone: ZEITZONE }).format(new Date());

/** Ortszeit (Stunde, Minute, Wochentag 0=So) in Svens Zeitzone. */
export function ortszeit(): { stunde: number; minute: number; wochentag: number } {
  const t = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: ZEITZONE, hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { stunde: Number(t.hour), minute: Number(t.minute), wochentag: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(t.weekday) };
}

// ─── Kurse ───────────────────────────────────────────────────────────────────

async function yahoo(ticker: string): Promise<{ kurs: number; vortag: number | null; handelstag: string | null } | null> {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d`, {
    headers: { "user-agent": "Mozilla/5.0 (Agentensystem)" },
  });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    chart?: {
      result?: {
        meta?: { regularMarketPrice?: number; regularMarketTime?: number };
        timestamp?: number[];
        indicators?: { quote?: { close?: (number | null)[] }[] };
      }[];
    };
  };
  const r = j.chart?.result?.[0];
  const meta = r?.meta;
  if (!meta?.regularMarketPrice) return null;
  // Vortag = Schlusskurs des Handelstags vor dem letzten. (Nicht «chartPreviousClose»: das ist der Kurs
  // vor Beginn des 5-Tage-Fensters und ergab eine 5-Tage-Veränderung statt einer Tagesbewegung.)
  const tag = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: ZEITZONE }).format(new Date(t * 1000));
  const handelstag = meta.regularMarketTime ? tag(meta.regularMarketTime) : null;
  const schluss = (r.timestamp ?? [])
    .map((t, i) => ({ tag: tag(t), kurs: r.indicators?.quote?.[0]?.close?.[i] ?? null }))
    .filter((x): x is { tag: string; kurs: number } => x.kurs != null && x.tag !== handelstag);
  return { kurs: meta.regularMarketPrice, vortag: schluss.at(-1)?.kurs ?? null, handelstag };
}

/** Basiswerte strukturierter Produkte (z. B. Amazon bei der Booster-Note) nachführen. */
async function basiswerte(): Promise<void> {
  const { data } = await db().from("wertpapiere").select("id, produkt").not("produkt", "is", null);
  for (const w of data ?? []) {
    const p = w.produkt as { basis_ticker?: string } & Record<string, unknown>;
    if (!p?.basis_ticker) continue;
    const k = await yahoo(p.basis_ticker).catch(() => null);
    if (!k) continue;
    await db()
      .from("wertpapiere")
      .update({ produkt: { ...p, basis_kurs: k.kurs, basis_kurs_am: new Date().toISOString() } })
      .eq("id", w.id);
  }
}

/** Kurse holen, Limits prüfen, bei grossen Tagesbewegungen warnen. Gibt die Anzahl aktualisierter Kurse zurück. */
export async function kurseUndLimits(): Promise<number> {
  await basiswerte();
  const { data } = await db().from("wertpapiere").select("*").not("ticker", "is", null);
  let n = 0;
  for (const w of (data ?? []) as Wertpapier[]) {
    const k = await yahoo(w.ticker!).catch(() => null);
    if (!k) continue;
    n++;
    await db()
      .from("wertpapiere")
      .update({ kurs: k.kurs, kurs_vortag: k.vortag, kurs_am: new Date().toISOString() })
      .eq("id", w.id);

    // Eigene Limits
    const { data: limits } = await db().from("kurs_limits").select("id, art, kurs, stueck").eq("wertpapier_id", w.id).eq("aktiv", true);
    for (const l of limits ?? []) {
      const erreicht = l.art === "verkauf" ? k.kurs >= l.kurs : k.kurs <= l.kurs;
      if (!erreicht) continue;
      await db().from("tasks").insert({
        titel: `${l.art === "verkauf" ? "Verkaufslimit" : "Kauflimit"} erreicht: ${w.emisora} bei ${k.kurs.toFixed(2)} ${w.waehrung}`,
        grund: `Dein Limit: ${l.art} ${l.stueck ? `${l.stueck} Stück ` : ""}zu ${l.kurs} ${w.waehrung}. Der Agent führt nichts aus, du entscheidest.`,
        quelle: "finanz",
        wertpapier_id: w.id,
      });
      await db().from("kurs_limits").update({ aktiv: false, ausgeloest_am: new Date().toISOString() }).eq("id", l.id);
      await log("finanz", "limit_erreicht", w.emisora, `${l.art} ${l.kurs}, Kurs ${k.kurs}`);
    }

    // Grosse Tagesbewegung
    // Nur warnen, wenn heute gehandelt wurde (am Wochenende nicht die Bewegung vom Freitag nochmals melden).
    if (k.vortag && k.handelstag === heute() && Math.abs(k.kurs / k.vortag - 1) >= WARNSCHWELLE && w.warnung_am !== heute()) {
      const pct = ((k.kurs / k.vortag - 1) * 100).toFixed(1);
      await db().from("tasks").insert({
        titel: `Starke Bewegung: ${w.emisora} ${Number(pct) > 0 ? "+" : ""}${pct} % heute`,
        grund: `Kurs ${k.kurs.toFixed(2)} ${w.waehrung}, Vortag ${k.vortag.toFixed(2)}. ${GRUND_FOLGT}`,
        quelle: "finanz",
        wertpapier_id: w.id,
        faellig_am: heute(),
      });
      // Bericht sofort neu anfordern: die Recherche sucht dann gezielt nach dem Grund der Bewegung.
      await db().from("wertpapiere").update({ warnung_am: heute(), bericht_am: null }).eq("id", w.id);
    }
  }
  return n;
}

const GRUND_FOLGT = "Der Agent sucht in den News nach dem Grund; die Erklärung erscheint hier in etwa 10–30 Minuten.";

/** Den gefundenen Grund in die offene Meldung «Starke Bewegung» schreiben. */
async function bewegungErklaeren(wertpapierId: string, grund: string): Promise<void> {
  const { data: offen } = await db()
    .from("tasks")
    .select("id, grund")
    .eq("wertpapier_id", wertpapierId)
    .eq("status", "offen")
    .like("titel", "Starke Bewegung:%");
  for (const t of offen ?? []) {
    const anfang = String(t.grund ?? "").replace(GRUND_FOLGT, "").trim();
    await db().from("tasks").update({ grund: `${anfang}\n\nGrund laut News: ${grund}` }).eq("id", t.id);
  }
}

// ─── Berichte je Wertpapier (Batch mit Websuche) ─────────────────────────────

export const Bericht = z.object({
  name: z.string().nullish(),
  sektor: z.string().nullish(),
  beschreibung: z.string().nullish(),
  kurs: z.number().nullish(),
  waehrung: z.string().nullish(),
  kgv: z.number().nullish(),
  kgv_erwartet: z.number().nullish(),
  kbv: z.number().nullish(),
  dividendenrendite: z.number().nullish(),
  dividende_pro_jahr: z.number().nullish(),
  naechste_dividende_ex: z.string().nullish(),
  naechste_dividende_zahltag: z.string().nullish(),
  naechste_dividende_betrag: z.number().nullish(),
  marktkapitalisierung: z.string().nullish(),
  hoch_52w: z.number().nullish(),
  tief_52w: z.number().nullish(),
  naechste_zahlen: z.string().nullish(),
  analysten_kaufen: z.number().nullish(),
  analysten_halten: z.number().nullish(),
  analysten_verkaufen: z.number().nullish(),
  kursziel: z.number().nullish(),
  analysten_zusammenfassung: z.string().nullish(),
  bewegung_grund: z.string().nullish(),
  news: z.array(z.object({ datum: z.string().nullish(), titel: z.string(), bedeutung: z.string().nullish() })).default([]),
  chancen: z.array(z.string()).default([]),
  risiken: z.array(z.string()).default([]),
  steuer: z.array(z.string()).default([]),
  quellen: z.array(z.object({ titel: z.string().nullish(), url: z.string() })).default([]),
});
export type Bericht = z.infer<typeof Bericht>;

const BERICHT_SYSTEM = `Du recherchierst für Sven ein Wertpapier in seinem Depot und lieferst einen kompakten Bericht auf Deutsch.
Sven ist ausschliesslich in Mexiko steuerlich ansässig und hält das Papier über HSBC Casa de Bolsa (México).
Recherchiere mit der Websuche aktuelle Daten: Kurs, Kennzahlen (KGV, erwartetes KGV, KBV, Dividendenrendite, Dividende pro Jahr),
nächste Dividende (Ex-Tag, Zahltag, Betrag), nächste Quartalszahlen, Analystenmeinungen (Anzahl Kaufen/Halten/Verkaufen, mittleres Kursziel),
wichtigste News der letzten zwei Wochen, Chancen und Risiken.
Unter «steuer» nennst du sachliche steuerliche Hinweise für eine in Mexiko ansässige Privatperson zu diesem Papier
(z. B. ISR auf Gewinne aus Verkäufen über die Börse, Quellensteuer auf Dividenden, Besonderheiten bei Fonds, ETFs, ausländischen Titeln im SIC oder strukturierten Noten), möglichst mit Quelle.
Das ist keine Anlage- oder Steuerberatung; gib keine Kauf- oder Verkaufsempfehlung als Auftrag.
Fehlt eine Angabe, lass sie weg. Nichts erfinden. Prozentwerte als Zahl in Prozent (z. B. 3.2 für 3,2 %).
Antworte am Schluss ausschliesslich mit einem JSON-Objekt in einem \`\`\`json-Block mit diesen Feldern:
name, sektor, beschreibung, kurs, waehrung, kgv, kgv_erwartet, kbv, dividendenrendite, dividende_pro_jahr,
naechste_dividende_ex (YYYY-MM-DD), naechste_dividende_zahltag (YYYY-MM-DD), naechste_dividende_betrag, marktkapitalisierung (Text),
hoch_52w, tief_52w, naechste_zahlen (YYYY-MM-DD), analysten_kaufen, analysten_halten, analysten_verkaufen, kursziel,
analysten_zusammenfassung, bewegung_grund (nur wenn im Auftrag nach einer Kursbewegung gefragt), news [{datum, titel, bedeutung}], chancen [], risiken [], steuer [], quellen [{titel, url}].`;

let client: Anthropic | undefined;
const anthropic = () => (client ??= new Anthropic());

/** Starke Bewegung heute (die Warnung ist schon raus): dann gezielt nach dem Grund suchen. */
function bewegungAuftrag(w: Wertpapier): string {
  if (w.warnung_am !== heute() || !w.kurs || !w.kurs_vortag) return "";
  const pct = ((w.kurs / w.kurs_vortag - 1) * 100).toFixed(1);
  return `\n\nWichtig: Der Kurs hat sich heute um ${Number(pct) > 0 ? "+" : ""}${pct} % bewegt (von ${w.kurs_vortag} auf ${w.kurs} ${w.waehrung}). Suche gezielt in den neuesten News (heute und gestern) nach dem Grund und erkläre ihn in «bewegung_grund» in 2–3 Sätzen, mit Quelle und Datum der Meldung. Findest du keinen konkreten Grund (z. B. nur allgemeine Marktbewegung), schreib genau das; nichts erfinden.`;
}

function berichtAnfrage(w: Wertpapier): Anthropic.Messages.MessageCreateParamsNonStreaming {
  return {
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "low" },
    system: BERICHT_SYSTEM,
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
    messages: [
      {
        role: "user",
        content: sauber(
          (w.produkt as ProduktDaten | null)?.basiswert
            ? `Strukturiertes Produkt ${w.emisora} auf den Basiswert ${(w.produkt as ProduktDaten).basiswert}. Recherchiere den Basiswert (Kennzahlen, Analysten, nächste Quartalszahlen, News); unter «steuer» Hinweise zu strukturierten Produkten/Warrants für in Mexiko Ansässige. Heute ist ${heute()}.`
            : `Wertpapier: ${w.emisora}${w.name ? ` (${w.name})` : ""}, Typ: ${w.typ}, Börse: Bolsa Mexicana de Valores bzw. HSBC México${w.ticker ? `, Ticker ${w.ticker}` : ""}. Heute ist ${heute()}.`,
        ) + bewegungAuftrag(w),
      },
    ],
  } as Anthropic.Messages.MessageCreateParamsNonStreaming;
}

function berichtLesen(m: Anthropic.Messages.Message): Bericht {
  if (m.stop_reason === "refusal") throw new Error("Claude hat die Anfrage abgelehnt");
  const text = m.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const json = text.match(/```json\s*([\s\S]*?)```/)?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return Bericht.parse(JSON.parse(json));
}

/** Wertpapiere, für die ein Bericht fällig ist: im Bestand oder mit Limit, Bericht älter als 20 Stunden oder angefordert. */
async function faelligeBerichte(): Promise<Wertpapier[]> {
  const { data } = await db().from("wertpapiere").select("*").neq("typ", "geldmarkt");
  const { data: bestand } = await db().from("depot_positionen").select("wertpapier_id, stueck, stand_am").order("stand_am", { ascending: false });
  const { data: limits } = await db().from("kurs_limits").select("wertpapier_id").eq("aktiv", true);
  const neuesterStand = new Map<string, number>();
  for (const b of bestand ?? []) if (!neuesterStand.has(b.wertpapier_id)) neuesterStand.set(b.wertpapier_id, Number(b.stueck));
  const relevant = new Set([
    ...[...neuesterStand].filter(([, s]) => s > 0).map(([id]) => id),
    ...(limits ?? []).map((l) => l.wertpapier_id as string),
  ]);
  const grenze = Date.now() - 20 * 3600_000;
  return ((data ?? []) as Wertpapier[]).filter((w) => relevant.has(w.id) && (!w.bericht_am || Date.parse(w.bericht_am) < grenze));
}

/** Batch einreichen (wenn nichts läuft) oder laufenden Batch abholen. */
export async function berichteBatch(): Promise<string> {
  const { data: stand } = await db().from("agent_stand").select("wert").eq("schluessel", "finanz_batch").maybeSingle();
  const laufend = stand?.wert as { id: string; papiere: string[] } | null;

  if (laufend) {
    const batch = await anthropic().messages.batches.retrieve(laufend.id);
    if (batch.processing_status !== "ended") return `Batch läuft (${batch.request_counts.processing} offen)`;
    let ok = 0;
    for await (const r of await anthropic().messages.batches.results(laufend.id)) {
      const id = r.custom_id;
      try {
        if (r.result.type !== "succeeded") throw new Error(`Batch: ${r.result.type}`);
        const bericht = berichtLesen(r.result.message);
        await db()
          .from("wertpapiere")
          .update({ bericht, bericht_am: new Date().toISOString(), bericht_fehler: null, ...(bericht.name ? { name: bericht.name } : {}) })
          .eq("id", id);
        if (bericht.bewegung_grund) await bewegungErklaeren(id, bericht.bewegung_grund);
        ok++;
      } catch (err) {
        await db()
          .from("wertpapiere")
          .update({ bericht_fehler: err instanceof Error ? err.message : String(err), bericht_am: new Date().toISOString() })
          .eq("id", id);
      }
    }
    await db().from("agent_stand").delete().eq("schluessel", "finanz_batch");
    await log("finanz", "berichte", null, `${ok} von ${laufend.papiere.length} Berichten aktualisiert`);
    return `${ok} Berichte aktualisiert`;
  }

  const faellig = await faelligeBerichte();
  if (!faellig.length) return "keine Berichte fällig";
  const batch = await anthropic().messages.batches.create({
    requests: faellig.map((w) => ({ custom_id: w.id, params: berichtAnfrage(w) })),
  });
  await db()
    .from("agent_stand")
    .upsert({ schluessel: "finanz_batch", wert: { id: batch.id, papiere: faellig.map((w) => w.id) }, aktualisiert_am: new Date().toISOString() });
  return `Batch mit ${faellig.length} Berichten gestartet`;
}

// ─── Tägliches Briefing ──────────────────────────────────────────────────────

export async function briefing(frist: number): Promise<string> {
  const tag = heute();
  const { data: schon } = await db().from("reports").select("id").eq("agent", "finanz").eq("zeitraum", tag).limit(1);
  if (schon?.length) return "Briefing schon erstellt";

  const [{ data: papiere }, { data: bestand }, { data: limits }, { data: orders }, { data: ziel }] = await Promise.all([
    db().from("wertpapiere").select("*"),
    db().from("depot_positionen").select("wertpapier_id, stueck, wert, kosten_bank, stand_am").order("stand_am", { ascending: false }),
    db().from("kurs_limits").select("wertpapier_id, art, kurs").eq("aktiv", true),
    db().from("depot_orders").select("emisora, art, stueck, kurs, gueltig_bis"),
    db().from("finanz_ziele").select("titel, betrag, waehrung, bis").eq("aktiv", true).limit(1),
  ]);
  const stueck = new Map<string, number>();
  for (const b of bestand ?? []) if (!stueck.has(b.wertpapier_id)) stueck.set(b.wertpapier_id, Number(b.stueck));

  const zeilen = ((papiere ?? []) as Wertpapier[])
    .filter((w) => (stueck.get(w.id) ?? 0) > 0)
    .map((w) => {
      const b = w.bericht;
      const s = stueck.get(w.id) ?? 0;
      const pct = w.kurs && w.kurs_vortag ? ((w.kurs / w.kurs_vortag - 1) * 100).toFixed(1) : "?";
      return [
        `- ${w.emisora} (${w.typ}): ${s} Stück, Kurs ${w.kurs ?? "?"} ${w.waehrung} (${pct} % zum Vortag), Wert ca. ${w.kurs ? Math.round(w.kurs * s) : "?"}`,
        b?.naechste_dividende_ex ? `  Dividende: Ex ${b.naechste_dividende_ex}, Betrag ${b.naechste_dividende_betrag ?? "?"}` : null,
        b?.naechste_zahlen ? `  Nächste Zahlen: ${b.naechste_zahlen}` : null,
        b?.analysten_zusammenfassung ? `  Analysten: ${b.analysten_zusammenfassung}` : null,
        ...(b?.news ?? []).slice(0, 3).map((n) => `  News ${n.datum ?? ""}: ${n.titel}${n.bedeutung ? ` – ${n.bedeutung}` : ""}`),
        ...(limits ?? []).filter((l) => l.wertpapier_id === w.id).map((l) => `  Eigenes Limit: ${l.art} zu ${l.kurs}`),
        produktZeile(w),
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  const daten = `Heute ist ${tag}.
Depot:
${zeilen || "(keine Positionen importiert)"}
Offene Aufträge bei der Bank: ${(orders ?? []).map((o) => `${o.art} ${o.stueck} ${o.emisora} zu ${o.kurs} bis ${o.gueltig_bis}`).join("; ") || "keine"}
Ziel: ${ziel?.[0] ? `${ziel[0].betrag} ${ziel[0].waehrung} bis ${ziel[0].bis}` : "keins"}`;

  const b = await briefingSchreiben(daten, frist);
  await db().from("reports").insert({ agent: "finanz", zeitraum: tag, inhalt: b });
  await log("finanz", "briefing", tag, b.titel);
  return "Briefing erstellt";
}

// ─── Kreditkarten: Erinnerung vor der Zahlungsfrist ──────────────────────────

/** 3 Tage vor der Frist eine Aufgabe, einmal pro Frist. */
export async function kreditkartenErinnern(): Promise<number> {
  const grenze = new Date(Date.parse(`${heute()}T12:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10);
  const { data } = await db()
    .from("konten")
    .select("id, name, institut, saldo, waehrung, zahlung_bis, zahlung_erinnert_fuer")
    .eq("typ", "kreditkarte")
    .eq("aktiv", true)
    .lt("saldo", 0)
    .not("zahlung_bis", "is", null)
    .lte("zahlung_bis", grenze);
  let n = 0;
  for (const k of data ?? []) {
    if (k.zahlung_erinnert_fuer === k.zahlung_bis) continue;
    await db().from("tasks").insert({
      titel: `Kreditkarte bezahlen: ${k.institut} ${k.name}`,
      grund: `Offen ${k.waehrung} ${Math.abs(Number(k.saldo)).toLocaleString("de-CH", { minimumFractionDigits: 2 })}, Frist ${k.zahlung_bis}. Betrag ggf. im Bankportal prüfen.`,
      quelle: "finanz",
      faellig_am: k.zahlung_bis,
    });
    await db().from("konten").update({ zahlung_erinnert_fuer: k.zahlung_bis }).eq("id", k.id);
    n++;
  }
  return n;
}
