// Rendite-Berechnung, die berücksichtigt, wann gekauft, verkauft und Dividende erhalten wurde
// (geldgewichtet, XIRR), statt wie die Bank nur mit dem Durchschnittspreis.

export interface Zahlung {
  datum: string; // YYYY-MM-DD
  betrag: number; // aus Sicht des Anlegers: Kauf negativ, Verkauf/Dividende/Endwert positiv
}

const JAHR_MS = 365 * 86_400_000;

/** Interner Zinsfuss pro Jahr (XIRR). null, wenn nicht berechenbar. */
export function xirr(zahlungen: Zahlung[]): number | null {
  const z = zahlungen.filter((x) => x.betrag !== 0).sort((a, b) => a.datum.localeCompare(b.datum));
  if (z.length < 2 || !z.some((x) => x.betrag < 0) || !z.some((x) => x.betrag > 0)) return null;
  const t0 = Date.parse(z[0].datum);
  const jahre = z.map((x) => (Date.parse(x.datum) - t0) / JAHR_MS);
  // Weniger als ~2 Wochen Anlagedauer: Hochrechnung aufs Jahr ist nicht aussagekräftig.
  if (jahre[jahre.length - 1] < 14 / 365) return null;
  const f = (r: number) => z.reduce((s, x, i) => s + x.betrag / (1 + r) ** jahre[i], 0);
  const df = (r: number) => z.reduce((s, x, i) => s - (jahre[i] * x.betrag) / (1 + r) ** (jahre[i] + 1), 0);

  let r = 0.1;
  for (let i = 0; i < 100; i++) {
    const wert = f(r);
    const ableitung = df(r);
    if (Math.abs(wert) < 1e-7) return r;
    if (!ableitung) break;
    const neu = r - wert / ableitung;
    if (!Number.isFinite(neu) || neu <= -0.9999) break;
    if (Math.abs(neu - r) < 1e-10) return neu;
    r = neu;
  }
  // Fallback: Bisektion zwischen -99 % und +1000 %
  let lo = -0.9999;
  let hi = 10;
  if (f(lo) * f(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (f(lo) * f(mid) <= 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

export interface Bewegung {
  datum: string;
  typ: "kauf" | "verkauf" | "dividende";
  stueck: number;
  betrag: number; // Importe Neto (positiv)
}

export interface PositionsRendite {
  stueck: number;
  wert: number;
  gekauft: number; // Summe aller Käufe inkl. Kommission
  verkauft: number; // Erlöse aus Verkäufen
  dividenden: number; // netto nach ISR
  gewinn: number; // Wert + Verkäufe + Dividenden − Käufe
  renditeProzent: number | null; // Gewinn / Käufe
  xirr: number | null; // pro Jahr
  ersterKauf: string | null;
}

export function positionsRendite(bewegungen: Bewegung[], wert: number, stichtag: string): PositionsRendite {
  let gekauft = 0;
  let verkauft = 0;
  let dividenden = 0;
  let stueck = 0;
  const zahlungen: Zahlung[] = [];
  for (const b of bewegungen) {
    if (b.typ === "kauf") {
      gekauft += b.betrag;
      stueck += b.stueck;
      zahlungen.push({ datum: b.datum, betrag: -b.betrag });
    } else if (b.typ === "verkauf") {
      verkauft += b.betrag;
      stueck -= b.stueck;
      zahlungen.push({ datum: b.datum, betrag: b.betrag });
    } else {
      dividenden += b.betrag;
      zahlungen.push({ datum: b.datum, betrag: b.betrag });
    }
  }
  if (wert > 0) zahlungen.push({ datum: stichtag, betrag: wert });
  const gewinn = wert + verkauft + dividenden - gekauft;
  const kaeufe = bewegungen.filter((b) => b.typ === "kauf").map((b) => b.datum).sort();
  return {
    stueck,
    wert,
    gekauft,
    verkauft,
    dividenden,
    gewinn,
    renditeProzent: gekauft > 0 ? gewinn / gekauft : null,
    xirr: xirr(zahlungen),
    ersterKauf: kaeufe[0] ?? null,
  };
}

/** Ziel: Wie viel Rendite pro Jahr bzw. Sparrate pro Monat braucht es bis zum Zieldatum? */
export function zielRechnung(heute: number, ziel: number, jahre: number, rendite: number | null) {
  const noetigeRendite = heute > 0 && jahre > 0 ? (ziel / heute) ** (1 / jahre) - 1 : null;
  const r = rendite ?? 0;
  const prognose = heute * (1 + r) ** jahre;
  // Monatliche Sparrate, damit es mit Rendite r reicht (nachschüssig).
  const rm = (1 + r) ** (1 / 12) - 1;
  const n = Math.round(jahre * 12);
  const luecke = ziel - prognose;
  const sparrate = luecke <= 0 ? 0 : rm > 0 ? (luecke * rm) / ((1 + rm) ** n - 1) : luecke / Math.max(n, 1);
  return { noetigeRendite, prognose, sparrate };
}
