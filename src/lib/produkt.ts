// Strukturierte Produkte, z. B. «Booster» (Warrant mit Partizipation, Höchst- und Mindestauszahlung).
// Rechnet die Auszahlung am Stichtag aus dem Kurs des Basiswerts.

export interface Produkt {
  art: "booster";
  bezeichnung?: string;
  emittent?: string;
  basiswert: string; // z. B. «Amazon»
  basis_ticker: string; // z. B. «AMZN» (Yahoo Finance)
  basis_waehrung?: string;
  startkurs: number;
  nominal: number; // Auszahlungsbasis pro Titel, z. B. 100
  partizipation: number; // z. B. 1.5 = 150 % des Anstiegs
  hoechst: number; // Höchstauszahlung pro Titel, z. B. 118
  mindest: number; // Mindestauszahlung pro Titel, z. B. 85
  vergleich_schwelle?: number; // z. B. Kurs, ab dem das Ergebnis besser ist als CETES
  vergleich_text?: string;
  stichtag: string; // YYYY-MM-DD, nur dieser Schlusskurs zählt
  auszahlung?: string;
  termine?: { datum: string; text: string }[];
  beschreibung?: string; // freier Text (Absätze mit Leerzeile)
  basis_kurs?: number; // vom Agenten nachgeführt
  basis_kurs_am?: string;
}

/** Auszahlung pro Titel bei Basiswert-Kurs s. */
export function boosterAuszahlung(p: Produkt, s: number): number {
  const rendite = s / p.startkurs - 1;
  if (rendite >= 0) return Math.min(p.hoechst, p.nominal * (1 + p.partizipation * rendite));
  return Math.max(p.mindest, p.nominal * (1 + rendite));
}

/** Kursschwellen, an denen die Auszahlung die Höchst- bzw. Mindestgrenze erreicht. */
export function boosterSchwellen(p: Produkt) {
  return {
    hoechstAb: p.startkurs * (1 + (p.hoechst / p.nominal - 1) / p.partizipation),
    mindestUnter: p.startkurs * (p.mindest / p.nominal),
  };
}

export function bereich(p: Produkt, s: number): string {
  const { hoechstAb, mindestUnter } = boosterSchwellen(p);
  if (s >= hoechstAb) return "Maximum erreicht";
  if (p.vergleich_schwelle && s >= p.vergleich_schwelle) return "Zielbereich (besser als Vergleich, unter Maximum)";
  if (s >= p.startkurs) return "Gewinn, aber unter dem Vergleich";
  if (s >= mindestUnter) return "Verlust 1:1 wie der Basiswert";
  return "Untergrenze (Mindestauszahlung)";
}

// ─── Wahrscheinlichkeiten bis zum Stichtag (einfaches Modell, ohne Trend) ────

function normalVerteilung(x: number): number {
  // Abramowitz/Stegun-Näherung der Standardnormalverteilung
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/** Wahrscheinlichkeit, dass der Basiswert am Stichtag unter x liegt (lognormal, Volatilität sigma pro Jahr). */
export function wahrscheinlichkeitUnter(x: number, heute: number, sigma: number, jahre: number): number {
  if (jahre <= 0) return heute < x ? 1 : 0;
  const s = sigma * Math.sqrt(jahre);
  return normalVerteilung((Math.log(x / heute) + 0.5 * s * s) / s);
}

/** Erwartete Auszahlung pro Titel (numerisch über die Verteilung am Stichtag). */
export function erwarteteAuszahlung(p: Produkt, heute: number, sigma: number, jahre: number): number {
  if (jahre <= 0) return boosterAuszahlung(p, heute);
  const s = sigma * Math.sqrt(jahre);
  let summe = 0;
  let gewicht = 0;
  for (let z = -6; z <= 6; z += 0.01) {
    const dichte = Math.exp((-z * z) / 2);
    const kurs = heute * Math.exp(-0.5 * s * s + s * z);
    summe += dichte * boosterAuszahlung(p, kurs);
    gewicht += dichte;
  }
  return summe / gewicht;
}
