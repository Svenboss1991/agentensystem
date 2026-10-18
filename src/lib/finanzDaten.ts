import { hsbcLesen, type Blatt, type PapierTyp } from "./hsbcImport";
import { positionsRendite, xirr, type Bewegung, type PositionsRendite, type Zahlung } from "./rendite";
import { supabase, ZEITZONE } from "./supabase";

// Daten der Finanz-Seite: Import der HSBC-Dateien und Berechnung von Bestand und Rendite.

export interface Wertpapier {
  id: string;
  emisora: string;
  name: string | null;
  typ: PapierTyp;
  waehrung: string;
  ticker: string | null;
  kurs: number | null;
  kurs_vortag: number | null;
  kurs_am: string | null;
  bericht: Record<string, unknown> | null;
  bericht_am: string | null;
  bericht_fehler: string | null;
  notiz: string | null;
  produkt: import("./produkt").Produkt | null;
}

export interface Tx {
  id: string;
  datum: string;
  typ: string;
  konzept: string;
  emisora: string;
  wertpapier_id: string | null;
  stueck: number | null;
  kurs: number | null;
  betrag: number | null;
  kommission: number | null;
  iva: number | null;
  isr: number | null;
  zins: number | null;
  zinssatz: number | null;
  quelle: string;
}

export interface BankPosition {
  wertpapier_id: string;
  stand_am: string;
  stueck: number;
  kurs: number | null;
  wert: number | null;
  kosten_bank: number | null;
  kosten_durchschnitt: number | null;
}

export interface PositionAuswertung {
  papier: Wertpapier;
  bank: BankPosition | null;
  stueck: number;
  kurs: number | null;
  kursQuelle: "live" | "bank";
  veraenderungHeute: number | null;
  rendite: PositionsRendite;
  /** Teil des Bestands, für den keine Käufe bekannt sind (vor dem ersten Import): mit Durchschnittspreis der Bank angesetzt. */
  geschaetzt: { stueck: number; betrag: number; datum: string } | null;
}

export const heute = () => new Intl.DateTimeFormat("en-CA", { timeZone: ZEITZONE }).format(new Date());

const tickerVorschlag = (emisora: string, typ: PapierTyp) =>
  typ === "aktie" || typ === "etf" ? `${emisora.replace(/\s+/g, "")}.MX` : null;

// ─── Import ──────────────────────────────────────────────────────────────────

async function papierIds(eintraege: { emisora: string; typ: PapierTyp }[]): Promise<Map<string, string>> {
  const eindeutig = [...new Map(eintraege.filter((e) => e.emisora).map((e) => [e.emisora, e])).values()];
  if (eindeutig.length) {
    await supabase.from("wertpapiere").upsert(
      eindeutig.map((e) => ({ emisora: e.emisora, typ: e.typ, ticker: tickerVorschlag(e.emisora, e.typ) })),
      { onConflict: "emisora", ignoreDuplicates: true },
    );
  }
  const { data } = await supabase.from("wertpapiere").select("id, emisora");
  return new Map((data ?? []).map((w) => [w.emisora as string, w.id as string]));
}

/** Liest eine HSBC-Datei und speichert sie. Gibt eine kurze Meldung zurück. */
export async function hsbcImportieren(blaetter: Blatt[]): Promise<string> {
  const r = hsbcLesen(blaetter);

  if (r.art === "bewegungen") {
    const ids = await papierIds(
      r.transaktionen
        .filter((t) => t.emisora && t.papier_typ && t.papier_typ !== "geldmarkt")
        .map((t) => ({ emisora: t.emisora!, typ: t.papier_typ! })),
    );
    const { data, error } = await supabase
      .from("depot_transaktionen")
      .upsert(
        r.transaktionen.map((t) => ({
          depot: "HSBC",
          datum: t.datum,
          liquidation: t.liquidation,
          folio: t.folio,
          konzept: t.konzept,
          typ: t.typ,
          emisora: t.emisora ?? "",
          wertpapier_id: t.emisora ? (ids.get(t.emisora) ?? null) : null,
          stueck: t.stueck,
          kurs: t.kurs,
          betrag: t.betrag,
          brutto: t.brutto,
          kommission: t.kommission,
          iva: t.iva,
          isr: t.isr,
          zins: t.zins,
          zinssatz: t.zinssatz,
        })),
        { onConflict: "depot,folio,konzept,emisora,datum", ignoreDuplicates: true },
      )
      .select("id");
    if (error) throw new Error(error.message);
    return `Bewegungen: ${data?.length ?? 0} neu (${r.transaktionen.length - (data?.length ?? 0)} schon vorhanden)`;
  }

  if (r.art === "positionen") {
    const ids = await papierIds(r.positionen.filter((p) => p.papier_typ !== "geldmarkt").map((p) => ({ emisora: p.emisora, typ: p.papier_typ })));
    const zeilen = r.positionen
      .filter((p) => ids.has(p.emisora))
      .map((p) => ({
        depot: "HSBC",
        wertpapier_id: ids.get(p.emisora)!,
        stand_am: p.stand_am,
        stueck: p.stueck,
        kurs: p.kurs,
        wert: p.wert,
        kosten_bank: p.kosten_bank,
        kosten_durchschnitt: p.kosten_durchschnitt,
      }));
    const { error } = await supabase.from("depot_positionen").upsert(zeilen, { onConflict: "depot,wertpapier_id,stand_am" });
    if (error) throw new Error(error.message);
    // Nicht mehr aufgeführte Papiere: Bestand 0 (verkauft)
    const { data: alle } = await supabase.from("depot_positionen").select("wertpapier_id").gt("stueck", 0);
    const jetzt = new Set(zeilen.map((z) => z.wertpapier_id));
    const weg = [...new Set((alle ?? []).map((a) => a.wertpapier_id as string))].filter((id) => !jetzt.has(id));
    if (weg.length) {
      await supabase
        .from("depot_positionen")
        .upsert(weg.map((id) => ({ depot: "HSBC", wertpapier_id: id, stand_am: zeilen[0]?.stand_am ?? heute(), stueck: 0, wert: 0 })), {
          onConflict: "depot,wertpapier_id,stand_am",
        });
    }
    return `Positionen: ${zeilen.length} Bestände aktualisiert`;
  }

  if (r.art === "orders") {
    const ids = await papierIds([]);
    await supabase.from("depot_orders").delete().eq("depot", "HSBC");
    if (r.orders.length) {
      const { error } = await supabase.from("depot_orders").insert(
        r.orders.map((o) => ({
          depot: "HSBC",
          folio: o.folio,
          datum: o.datum,
          art: o.art,
          emisora: o.emisora,
          wertpapier_id: ids.get(o.emisora) ?? null,
          stueck: o.stueck,
          kurs: o.kurs,
          gueltig_bis: o.gueltig_bis,
          status: o.status,
        })),
      );
      if (error) throw new Error(error.message);
    }
    return `Offene Aufträge: ${r.orders.length}`;
  }

  throw new Error("Datei nicht erkannt. Erwartet werden die HSBC-Exporte «Movimientos», «Posiciones» oder «Órdenes Vigentes».");
}

// ─── Auswertung ──────────────────────────────────────────────────────────────

export interface Depot {
  positionen: PositionAuswertung[];
  wert: number;
  gewinn: number;
  dividenden: number;
  xirr: number | null;
  reportoZins: number;
  reportoSatz: number | null;
  reportoSeit: string | null;
  /** Betrag des letzten Reportos (nur Hinweis; Cash im Depot ist ein eigenes Konto, da nicht immer im Reporto). */
  cash: number;
  cashAm: string | null;
  transaktionen: Tx[];
}

export async function depotLaden(): Promise<Depot> {
  const [p, t, b] = await Promise.all([
    supabase.from("wertpapiere").select("*").order("emisora"),
    supabase.from("depot_transaktionen").select("*").order("datum"),
    supabase.from("depot_positionen").select("*").order("stand_am", { ascending: false }),
  ]);
  const papiere = (p.data ?? []) as Wertpapier[];
  const tx = (t.data ?? []) as Tx[];
  const neuesteBank = new Map<string, BankPosition>();
  for (const x of (b.data ?? []) as BankPosition[]) if (!neuesteBank.has(x.wertpapier_id)) neuesteBank.set(x.wertpapier_id, x);

  const stichtag = heute();
  const ersterImport = tx[0]?.datum ?? stichtag;
  const positionen: PositionAuswertung[] = [];
  const alleZahlungen: Zahlung[] = [];

  for (const papier of papiere.filter((x) => x.typ !== "geldmarkt")) {
    const bank = neuesteBank.get(papier.id) ?? null;
    const eigene = tx.filter((x) => x.wertpapier_id === papier.id && ["kauf", "verkauf", "dividende"].includes(x.typ));
    const bewegungen: Bewegung[] = eigene.map((x) => ({
      datum: x.datum,
      typ: x.typ as Bewegung["typ"],
      stueck: Number(x.stueck ?? 0),
      betrag: Number(x.betrag ?? 0),
    }));
    const netto = (liste: Bewegung[]) => liste.reduce((s, x) => s + (x.typ === "kauf" ? x.stueck : x.typ === "verkauf" ? -x.stueck : 0), 0);
    const bekannt = netto(bewegungen);
    // Bestand: letzter Bank-Stand des Titels (verkaufte haben dort 0) plus Käufe/Verkäufe danach. Ohne Bank-Stand
    // aus den Bewegungen, aber nie negativ (ein Verkauf ohne bekannten Kauf heisst: vor dem ersten Import gekauft).
    const stueck = bank
      ? Math.max(0, Number(bank.stueck) + netto(bewegungen.filter((x) => x.datum > bank.stand_am)))
      : Math.max(0, bekannt);

    // Bestand vor dem ersten Import: mit Durchschnittspreis der Bank zum ersten bekannten Datum ansetzen.
    let geschaetzt: PositionAuswertung["geschaetzt"] = null;
    const fehlt = Math.round((stueck - bekannt) * 1e6) / 1e6;
    // Einstandspreis: Durchschnitt der Bank; fehlt der (Titel schon verkauft), der Verkaufspreis, also Gewinn 0.
    const verkaeufe = bewegungen.filter((x) => x.typ === "verkauf");
    const verkaufspreis = verkaeufe.length
      ? verkaeufe.reduce((s, x) => s + x.betrag, 0) / verkaeufe.reduce((s, x) => s + x.stueck, 0)
      : null;
    const einstand = bank?.kosten_durchschnitt ? Number(bank.kosten_durchschnitt) : verkaufspreis;
    if (fehlt > 0 && einstand) {
      const ersterEigener = bewegungen[0]?.datum ?? ersterImport;
      const datum = ersterEigener < ersterImport ? ersterEigener : ersterImport;
      geschaetzt = { stueck: fehlt, betrag: fehlt * einstand, datum };
      bewegungen.unshift({ datum, typ: "kauf", stueck: fehlt, betrag: geschaetzt.betrag });
    }

    const liveAktuell = papier.kurs != null && papier.kurs_am && (!bank || papier.kurs_am.slice(0, 10) >= bank.stand_am);
    const kurs = liveAktuell ? Number(papier.kurs) : bank?.kurs != null ? Number(bank.kurs) : null;
    const wert = !stueck ? 0 : kurs != null ? kurs * stueck : Number(bank?.wert ?? 0);
    if (!bewegungen.length && !stueck) continue;

    const rendite = positionsRendite(bewegungen, wert, stichtag);
    positionen.push({
      papier,
      bank,
      stueck,
      kurs,
      kursQuelle: liveAktuell ? "live" : "bank",
      veraenderungHeute: liveAktuell && papier.kurs_vortag ? Number(papier.kurs) / Number(papier.kurs_vortag) - 1 : null,
      rendite,
      geschaetzt,
    });
    for (const x of bewegungen) alleZahlungen.push({ datum: x.datum, betrag: x.typ === "kauf" ? -x.betrag : x.betrag });
    if (wert > 0) alleZahlungen.push({ datum: stichtag, betrag: wert });
  }

  const reporto = tx.filter((x) => x.typ === "reporto_ende");
  const starts = tx.filter((x) => x.typ === "reporto_start");
  const letzterTag = starts.length ? starts[starts.length - 1].datum : null;
  const letzterReporto = starts.filter((x) => x.datum === letzterTag);
  const saetze = reporto.map((x) => Number(x.zinssatz)).filter((x) => x > 0);
  return {
    positionen: positionen.sort((a, b) => b.rendite.wert - a.rendite.wert),
    wert: positionen.reduce((s, x) => s + x.rendite.wert, 0),
    gewinn: positionen.reduce((s, x) => s + x.rendite.gewinn, 0),
    dividenden: positionen.reduce((s, x) => s + x.rendite.dividenden, 0),
    xirr: xirr(alleZahlungen),
    reportoZins: reporto.reduce((s, x) => s + Number(x.zins ?? 0), 0),
    reportoSatz: saetze.length ? saetze.reduce((a, b) => a + b, 0) / saetze.length : null,
    reportoSeit: reporto[0]?.datum ?? null,
    cash: letzterReporto.reduce((s, x) => s + Number(x.betrag ?? 0), 0),
    cashAm: letzterReporto[0]?.datum ?? null,
    transaktionen: tx,
  };
}

export const geld = (n: number | null | undefined, w = "MXN", stellen = 0) =>
  n == null || !Number.isFinite(n)
    ? "–"
    : `${w} ${n.toLocaleString("de-CH", { minimumFractionDigits: stellen, maximumFractionDigits: stellen })}`;

export const prozent = (n: number | null | undefined, stellen = 1) =>
  n == null || !Number.isFinite(n) ? "–" : `${n > 0 ? "+" : ""}${(n * 100).toLocaleString("de-CH", { minimumFractionDigits: stellen, maximumFractionDigits: stellen })} %`;

// ─── Konten und Karten ───────────────────────────────────────────────────────

export interface Konto {
  id: string;
  name: string;
  institut: string;
  typ: "konto" | "sparen" | "festgeld" | "fonds" | "kreditkarte" | "kaution" | "sonstiges";
  endziffern: string | null;
  waehrung: string;
  saldo: number;
  saldo_am: string;
  zinssatz: number | null;
  zahlung_bis: string | null;
  notiz: string | null;
  aktiv: boolean;
  sortierung: number;
}

export async function kontenLaden(): Promise<Konto[]> {
  const { data } = await supabase.from("konten").select("*").eq("aktiv", true).order("institut").order("sortierung").order("name");
  return ((data ?? []) as Konto[]).map((k) => ({ ...k, saldo: Number(k.saldo), zinssatz: k.zinssatz == null ? null : Number(k.zinssatz) }));
}

/** Saldo ändern und im Verlauf festhalten. */
export async function saldoSetzen(konto: Konto, saldo: number): Promise<void> {
  const tag = heute();
  await supabase.from("konten").update({ saldo, saldo_am: tag }).eq("id", konto.id);
  await supabase.from("konten_saldi").upsert({ konto_id: konto.id, datum: tag, saldo }, { onConflict: "konto_id,datum" });
}
