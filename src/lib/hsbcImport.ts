// Import der Excel-Exporte von HSBC Casa de Bolsa (México):
// «Movimientos Históricos», «Posiciones» und «Órdenes Vigentes». Erkennt die Datei am Tabellenkopf.

export type Zelle = string | number | boolean | Date | null | undefined;
export interface Blatt {
  sheet: string;
  data: Zelle[][];
}

export type TxTyp =
  | "kauf"
  | "verkauf"
  | "dividende"
  | "einzahlung"
  | "auszahlung"
  | "reporto_start"
  | "reporto_ende"
  | "sonstiges";

export type PapierTyp = "aktie" | "etf" | "fonds" | "note" | "geldmarkt" | "sonstiges";

export interface Transaktion {
  datum: string; // YYYY-MM-DD
  liquidation: string | null;
  folio: string;
  konzept: string;
  typ: TxTyp;
  emisora: string | null;
  papier_typ: PapierTyp | null;
  stueck: number | null;
  kurs: number | null;
  betrag: number | null; // Importe Neto (nach Kommission, IVA, ISR)
  brutto: number | null;
  kommission: number | null;
  iva: number | null;
  isr: number | null;
  zins: number | null;
  zinssatz: number | null; // Reporto, % p. a.
}

export interface Position {
  emisora: string;
  papier_typ: PapierTyp;
  stueck: number;
  kurs: number;
  wert: number;
  kosten_bank: number;
  kosten_durchschnitt: number;
  stand_am: string;
}

export interface Order {
  folio: string;
  datum: string | null;
  art: "kauf" | "verkauf";
  emisora: string;
  stueck: number;
  kurs: number;
  gueltig_bis: string | null;
  status: string;
}

export type ImportErgebnis =
  | { art: "bewegungen"; transaktionen: Transaktion[] }
  | { art: "positionen"; positionen: Position[] }
  | { art: "orders"; orders: Order[] }
  | { art: "unbekannt" };

/** «1,606» / «$ -2,356.03» / «-2.36%» / 1000 → Zahl */
export function zahl(z: Zelle): number | null {
  if (z == null || z === "") return null;
  if (typeof z === "number") return z;
  const t = String(z).replace(/[$%\s,]/g, "").replace(/^[CV]/, "");
  if (t === "" || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** «16/10/26» oder «16/10/2026» → «2026-10-16» */
export function datum(z: Zelle): string | null {
  if (z instanceof Date) return z.toISOString().slice(0, 10);
  const m = String(z ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const jahr = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${jahr}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

/** «1 ASUR B» → «ASUR B», «1B VMEX 19» → «VMEX 19», «HSBC-D2-BFS» → «HSBC D2 BFS» */
export function emisoraNormal(z: Zelle): string | null {
  const t = String(z ?? "").trim();
  if (!t) return null;
  return t
    .replace(/^1[A-Z]?\s+/, "")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function papierTyp(roh: string, konzept = ""): PapierTyp {
  if (/^BI\s|CETES|BONDES|UDIBONO/i.test(roh)) return "geldmarkt";
  if (/FONDO/i.test(konzept)) return "fonds";
  if (/^1B\s/.test(roh)) return "etf";
  if (/^1[A-Z]?\s/.test(roh)) return "aktie";
  return "sonstiges";
}

function txTyp(konzept: string): TxTyp {
  const k = konzept.toUpperCase();
  if (k.includes("REPORTO")) return k.includes("INICIO") ? "reporto_start" : "reporto_ende";
  if (k.startsWith("COMPRA")) return "kauf";
  if (k.startsWith("VENTA")) return "verkauf";
  if (k.includes("DIVIDENDO")) return "dividende";
  if (k.includes("DEPOSITO")) return "einzahlung";
  if (k.includes("RETIRO") || k.includes("TRANSFERENCIA")) return "auszahlung";
  return "sonstiges";
}

const kopfIndex = (data: Zelle[][], erste: string) =>
  data.findIndex((r) => String(r[0] ?? "").toLowerCase().startsWith(erste.toLowerCase()));

function bewegungen(data: Zelle[][]): Transaktion[] {
  const k = kopfIndex(data, "Fecha de operacion");
  const kopf = data[k].map((c) => String(c ?? "").trim().toLowerCase());
  const spalte = (name: string) => kopf.indexOf(name.toLowerCase());
  const s = {
    datum: spalte("Fecha de operacion"),
    liq: spalte("Fecha de liquidacion"),
    folio: spalte("Folio"),
    konzept: spalte("Concepto"),
    emisora: spalte("Emisora"),
    titulos: spalte("Titulos"),
    costo: spalte("Costo"),
    neto: spalte("Importe Neto"),
    importe: spalte("Importe"),
    comision: spalte("Comision"),
    interes: spalte("Interes"),
    iva: spalte("IVA"),
    isr: spalte("ISR"),
  };
  return data
    .slice(k + 1)
    .filter((r) => r[s.konzept] && datum(r[s.datum]))
    .map((r) => {
      const konzept = String(r[s.konzept]).trim();
      const roh = String(r[s.emisora] ?? "").trim();
      const typ = txTyp(konzept);
      const zins = zahl(r[s.interes]);
      const isr = zahl(r[s.isr]);
      const iva = zahl(r[s.iva]);
      const neto = zahl(r[s.neto]);
      const importe = zahl(r[s.importe]);
      // Im Export sind Spalten verschoben (Kommission steht unter «Tasa», der Reporto-Zinssatz unter «Comision»).
      // Darum Kommission aus der Differenz von Importe und Importe Neto abzüglich IVA berechnen.
      const kommission =
        (typ === "kauf" || typ === "verkauf") && neto != null && importe != null
          ? Math.round((Math.abs(neto - importe) - (iva ?? 0)) * 100) / 100
          : null;
      return {
        datum: datum(r[s.datum])!,
        liquidation: datum(r[s.liq]),
        folio: String(r[s.folio] ?? "").trim(),
        konzept,
        typ,
        emisora: emisoraNormal(roh),
        papier_typ: roh ? papierTyp(roh, konzept) : null,
        stueck: zahl(r[s.titulos]),
        kurs: zahl(r[s.costo]),
        betrag: neto,
        brutto: importe,
        kommission,
        iva,
        isr,
        zinssatz: typ.startsWith("reporto") ? zahl(r[s.comision]) : null,
        // Reporto: Zins nach Steuer, nur beim Ende gutgeschrieben
        zins: typ === "reporto_ende" && zins != null ? Math.round((zins - (isr ?? 0)) * 100) / 100 : null,
      };
    });
}

function positionen(blaetter: Blatt[]): Position[] {
  const ergebnis: Position[] = [];
  for (const b of blaetter) {
    const k = kopfIndex(b.data, "Emisora");
    if (k < 0) continue;
    const kopf = b.data[k].map((c) => String(c ?? "").trim().toLowerCase());
    const spalte = (name: string) => kopf.indexOf(name.toLowerCase());
    const geldmarkt = /dinero/i.test(b.sheet);
    for (const r of b.data.slice(k + 1)) {
      const roh = String(r[spalte("Emisora")] ?? "").trim();
      const stueck = zahl(r[spalte("Títulos")]);
      if (!roh || stueck == null) continue;
      const kosten = zahl(r[spalte("Importe al costo")]) ?? 0;
      const fecha = datum(r[spalte("Hora/Fecha")]);
      ergebnis.push({
        emisora: emisoraNormal(roh)!,
        // In «Posiciones» fehlt der Präfix; Fonds erkennt man an der Endung «BFS/BFV/…», Geldmarkt am Blatt.
        papier_typ: geldmarkt
          ? "geldmarkt"
          : /HSBC|FONDO/i.test(roh) && /\sBF[A-Z]$/.test(roh)
            ? "fonds"
            : /^[A-Z]{3}\d{3}R\s/.test(roh)
              ? "note" // strukturierte Note, z. B. «AMZ703R BS004»
              : "aktie",
        stueck,
        kurs: zahl(r[spalte("Precio de mercado")]) ?? 0,
        wert: zahl(r[spalte("Valor de mercado")]) ?? 0,
        kosten_bank: kosten,
        kosten_durchschnitt: zahl(r[spalte("Costo promedio")]) ?? 0,
        stand_am: fecha ?? new Date().toISOString().slice(0, 10),
      });
    }
  }
  return ergebnis;
}

function orders(blaetter: Blatt[]): Order[] {
  const ergebnis: Order[] = [];
  for (const b of blaetter.filter((x) => /capitales|fondos/i.test(x.sheet))) {
    const k = kopfIndex(b.data, "Folio");
    if (k < 0) continue;
    const kopf = b.data[k].map((c) => String(c ?? "").trim().toLowerCase());
    const spalte = (name: string) => kopf.indexOf(name.toLowerCase());
    for (const r of b.data.slice(k + 1)) {
      const folio = String(r[spalte("Folio")] ?? "").trim();
      if (!folio) continue;
      ergebnis.push({
        folio,
        // Der Export liefert hier teils unsinnige Daten (z. B. 2031); nur plausible übernehmen.
        datum: ((d) => (d && d <= new Date().toISOString().slice(0, 10) ? d : null))(datum(r[spalte("Fecha de operacion")])),
        art: /venta/i.test(String(r[spalte("Concepto")])) ? "verkauf" : "kauf",
        emisora: emisoraNormal(r[spalte("Emisora")]) ?? "",
        stueck: zahl(r[spalte("Titulos ordenados")]) ?? 0,
        kurs: zahl(r[spalte("Precio / Tasa")]) ?? 0,
        gueltig_bis: datum(r[spalte("Fecha de vigencia")]),
        status: String(r[spalte("Estatus")] ?? ""),
      });
    }
  }
  return ergebnis;
}

/** Erkennt die Datei am Inhalt und liest sie aus. */
export function hsbcLesen(blaetter: Blatt[]): ImportErgebnis {
  const text = (b: Blatt) => b.data.slice(0, 3).map((r) => r.join(" ")).join(" ").toUpperCase();
  const erstes = blaetter[0];
  if (!erstes) return { art: "unbekannt" };
  if (text(erstes).includes("MOVIMIENTOS")) return { art: "bewegungen", transaktionen: bewegungen(erstes.data) };
  if (text(erstes).includes("POSICIONES")) return { art: "positionen", positionen: positionen(blaetter) };
  if (text(erstes).includes("ORDENES VIGENTES")) return { art: "orders", orders: orders(blaetter) };
  return { art: "unbekannt" };
}
