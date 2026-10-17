import readXlsxFile from "read-excel-file/browser";
import { useCallback, useEffect, useState } from "react";
import Konten from "./Konten";
import { depotLaden, geld, heute, hsbcImportieren, kontenLaden, prozent, saldoSetzen, type Depot, type Konto, type PositionAuswertung } from "./lib/finanzDaten";
import type { Blatt } from "./lib/hsbcImport";
import { zielRechnung } from "./lib/rendite";
import { supabase, zeit } from "./lib/supabase";
import { Seite } from "./Seite";
import { Karte, Knopf } from "./ui";

interface Briefing {
  titel: string;
  punkte: { dringlichkeit: "hoch" | "mittel" | "info"; text: string }[];
}

interface Ziel {
  titel: string;
  betrag: number;
  waehrung: string;
  bis: string;
}

interface Limit {
  id: string;
  wertpapier_id: string;
  art: "kauf" | "verkauf";
  kurs: number;
  stueck: number | null;
  aktiv: boolean;
  ausgeloest_am: string | null;
  wertpapiere: { emisora: string; kurs: number | null } | null;
}

interface Order {
  folio: string;
  art: string;
  emisora: string;
  stueck: number;
  kurs: number;
  gueltig_bis: string | null;
  status: string;
}

const farbe = (n: number | null | undefined) => (n == null ? "text-stone-400" : n >= 0 ? "text-emerald-700" : "text-rose-700");
const datum = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("de-CH", { timeZone: "UTC" }) : "?");

// Farben für die Aufteilung des Depots; Cash immer grau.
const FARBEN = ["#1e3a8a", "#0f766e", "#b45309", "#7c3aed", "#be123c", "#0369a1", "#4d7c0f", "#a16207", "#9d174d", "#334155"];
const CASH_FARBE = "#a8a29e";

/** Das Konto, in dem Sven das Barguthaben im HSBC-Aktiendepot führt. */
const istDepotCash = (k: Konto) => /cash im depot|barguthaben.*depot/i.test(k.name);

export interface Analysten {
  kaufen: number;
  halten: number;
  verkaufen: number;
  summe: number;
  kursziel: number | null;
  potenzial: number | null;
  urteil: "Buy" | "Hold" | "Sell" | null;
}

/** Kursziel und Buy/Hold/Sell aus dem letzten Analysten-Bericht des Agenten. */
export function analystenVon(p: PositionAuswertung): Analysten {
  const b = (p.papier.bericht ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const kaufen = n(b.analysten_kaufen);
  const halten = n(b.analysten_halten);
  const verkaufen = n(b.analysten_verkaufen);
  const summe = kaufen + halten + verkaufen;
  const kursziel = typeof b.kursziel === "number" && b.kursziel > 0 ? b.kursziel : null;
  const potenzial = kursziel && p.kurs ? kursziel / p.kurs - 1 : null;
  // Urteil = die grösste Gruppe; bei Gleichstand Hold.
  const urteil = !summe ? null : kaufen > halten && kaufen > verkaufen ? "Buy" : verkaufen > halten && verkaufen > kaufen ? "Sell" : "Hold";
  return { kaufen, halten, verkaufen, summe, kursziel, potenzial, urteil };
}

export function FinanzenSeite() {
  const [depot, setDepot] = useState<Depot | null>(null);
  const [briefing, setBriefing] = useState<{ zeitraum: string; inhalt: Briefing } | null>(null);
  const [ziel, setZiel] = useState<Ziel | null>(null);
  const [limits, setLimits] = useState<Limit[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [meldung, setMeldung] = useState("");
  const [konten, setKonten] = useState<Konto[]>([]);

  const laden = useCallback(async () => {
    const [d, b, z, l, o, k] = await Promise.all([
      depotLaden(),
      supabase.from("reports").select("zeitraum, inhalt").eq("agent", "finanz").order("erstellt_am", { ascending: false }).limit(1),
      supabase.from("finanz_ziele").select("titel, betrag, waehrung, bis").eq("aktiv", true).limit(1),
      supabase.from("kurs_limits").select("id, wertpapier_id, art, kurs, stueck, aktiv, ausgeloest_am, wertpapiere(emisora, kurs)").order("erstellt_am", { ascending: false }),
      supabase.from("depot_orders").select("folio, art, emisora, stueck, kurs, gueltig_bis, status"),
      kontenLaden(),
    ]);
    setKonten(k);
    setDepot(d);
    setBriefing((b.data?.[0] as { zeitraum: string; inhalt: Briefing } | undefined) ?? null);
    setZiel((z.data?.[0] as Ziel | undefined) ?? null);
    setLimits((l.data ?? []) as unknown as Limit[]);
    setOrders((o.data ?? []) as Order[]);
  }, []);

  useEffect(() => {
    laden();
  }, [laden]);

  async function importieren(dateien: FileList | null) {
    if (!dateien?.length) return;
    const teile: string[] = [];
    for (const datei of Array.from(dateien)) {
      try {
        const blaetter = (await readXlsxFile(datei)) as unknown as Blatt[];
        teile.push(`${datei.name}: ${await hsbcImportieren(blaetter)}`);
      } catch (e) {
        teile.push(`${datei.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setMeldung(teile.join(" · "));
    await laden();
  }

  if (!depot) return <Seite titel="Finanzen">Lädt …</Seite>;

  // Das Barguthaben im Depot wird als Konto geführt, aber beim Depot gezeigt (und nur dort gezählt).
  const cashKonto = konten.find(istDepotCash) ?? null;
  const cash = cashKonto?.saldo ?? 0;
  const andereKonten = konten.filter((k) => k !== cashKonto);
  const depotGesamt = depot.wert + cash;
  const kontenSumme = andereKonten.reduce((s, k) => s + k.saldo, 0);
  const netto = depotGesamt + kontenSumme;

  const jahre = ziel ? (Date.parse(ziel.bis) - Date.parse(heute())) / (365.25 * 86_400_000) : 0;
  const z = ziel ? zielRechnung(netto, ziel.betrag, jahre, depot.xirr) : null;
  const fortschritt = ziel ? Math.max(0, Math.min(1, netto / ziel.betrag)) : 0;

  const positionen = [...depot.positionen].sort((a, b) => b.rendite.wert - a.rendite.wert);
  const anteil = (w: number) => (depotGesamt ? w / depotGesamt : 0);
  const farbeVon = new Map(positionen.map((p, i) => [p.papier.id, FARBEN[i % FARBEN.length]]));

  // Kurspotenzial laut Analysten, gewichtet nach Wert der Positionen mit Kursziel.
  const mitZiel = positionen.map((p) => ({ p, a: analystenVon(p) })).filter((x) => x.a.potenzial != null);
  const zielWert = mitZiel.reduce((s, x) => s + x.p.rendite.wert, 0);
  const potenzialGewichtet = zielWert ? mitZiel.reduce((s, x) => s + x.p.rendite.wert * (x.a.potenzial ?? 0), 0) / zielWert : null;

  return (
    <Seite titel="Finanzen" breit>
      {/* Vermögen und Ziel */}
      <section className="overflow-hidden rounded-2xl bg-stone-900 p-5 text-white shadow-sm sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wider text-stone-400">Nettovermögen</p>
            <p className="text-4xl font-semibold tabular-nums">{geld(netto)}</p>
            <p className="mt-1 text-xs text-stone-400">Depot {geld(depotGesamt)} · Konten und Karten {geld(kontenSumme)}</p>
          </div>
          {ziel && (
            <div className="text-right">
              <p className="text-xs uppercase tracking-wider text-stone-400">Ziel bis {datum(ziel.bis)}</p>
              <p className="text-xl font-semibold tabular-nums">{geld(ziel.betrag, ziel.waehrung)}</p>
              <p className="text-xs text-stone-400">noch {jahre.toFixed(1)} Jahre</p>
            </div>
          )}
        </div>
        {ziel && z && (
          <>
            <div className="mt-5 h-2.5 overflow-hidden rounded-full bg-stone-700">
              <div className="h-full rounded-full bg-emerald-400" style={{ width: `${(fortschritt * 100).toFixed(1)}%` }} />
            </div>
            <p className="mt-1.5 text-xs text-stone-400">{(fortschritt * 100).toFixed(1)} % erreicht</p>
            <dl className="mt-4 grid grid-cols-1 gap-3 border-t border-stone-700 pt-4 text-sm sm:grid-cols-3">
              <HeroWert titel="Nötige Rendite ohne Sparen" wert={`${prozent(z.noetigeRendite)} pro Jahr`} />
              <HeroWert titel="Prognose mit heutiger Rendite" wert={depot.xirr != null ? geld(z.prognose) : "– (zu kurze Historie)"} />
              <HeroWert titel="Nötige Sparrate pro Monat" wert={depot.xirr != null ? geld(z.sparrate) : "–"} />
            </dl>
          </>
        )}
      </section>

      {/* Kennzahlen Depot */}
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kennzahl titel="Depot inkl. Cash" wert={geld(depotGesamt)} hinweis={`davon Cash ${geld(cash)}`} />
        <Kennzahl titel="Gewinn inkl. Dividenden" wert={geld(depot.gewinn)} klasse={farbe(depot.gewinn)} hinweis={`Dividenden ${geld(depot.dividenden)}`} />
        <Kennzahl titel="Rendite pro Jahr" wert={prozent(depot.xirr)} klasse={farbe(depot.xirr)} hinweis="XIRR, berücksichtigt Kaufzeitpunkte" />
        <Kennzahl
          titel="Potenzial bis Kursziel"
          wert={prozent(potenzialGewichtet)}
          klasse={farbe(potenzialGewichtet)}
          hinweis={zielWert ? `Ø Analysten, gewichtet (${mitZiel.length} Titel)` : "noch keine Analystenberichte"}
        />
      </div>

      {/* Depot */}
      <h2 className="mb-3 mt-10 text-xl font-semibold">Aktiendepot HSBC</h2>
      <Karte>
        {/* Aufteilung */}
        {depotGesamt > 0 && (
          <div className="mb-5">
            <div className="flex h-3 overflow-hidden rounded-full bg-stone-100">
              {positionen.map((p) => (
                <div
                  key={p.papier.id}
                  title={`${p.papier.emisora} ${(anteil(p.rendite.wert) * 100).toFixed(1)} %`}
                  style={{ width: `${anteil(p.rendite.wert) * 100}%`, background: farbeVon.get(p.papier.id) }}
                />
              ))}
              {cash > 0 && <div title={`Cash ${(anteil(cash) * 100).toFixed(1)} %`} style={{ width: `${anteil(cash) * 100}%`, background: CASH_FARBE }} />}
            </div>
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-600">
              {positionen.map((p) => (
                <li key={p.papier.id} className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: farbeVon.get(p.papier.id) }} />
                  {p.papier.emisora} <span className="tabular-nums text-stone-400">{(anteil(p.rendite.wert) * 100).toFixed(1)} %</span>
                </li>
              ))}
              {cash > 0 && (
                <li className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: CASH_FARBE }} />
                  Cash <span className="tabular-nums text-stone-400">{(anteil(cash) * 100).toFixed(1)} %</span>
                </li>
              )}
            </ul>
          </div>
        )}

        {positionen.length ? (
          <div className="-mx-4 overflow-x-auto">
            <table className="w-full min-w-[60rem] text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-left text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-4 pb-2 font-medium">Titel</th>
                  <th className="px-2 pb-2 text-right font-medium">Kurs</th>
                  <th className="px-2 pb-2 text-right font-medium">Wert</th>
                  <th className="px-2 pb-2 text-right font-medium">Gewinn / Gesamt</th>
                  <th className="px-2 pb-2 text-right font-medium">p. a.</th>
                  <th className="px-2 pb-2 text-right font-medium">KGV</th>
                  <th className="px-2 pb-2 text-right font-medium">Div.-Rendite</th>
                  <th className="px-2 pb-2 text-right font-medium">Ø Kursziel</th>
                  <th className="px-4 pb-2 font-medium">Analysten</th>
                </tr>
              </thead>
              <tbody>
                {positionen.map((p) => (
                  <PositionsZeile key={p.papier.id} p={p} farbe={farbeVon.get(p.papier.id)!} anteil={anteil(p.rendite.wert)} />
                ))}
                <CashZeile konto={cashKonto} anteil={anteil(cash)} reporto={depot.cash} reportoAm={depot.cashAm} neuLaden={laden} />
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-stone-200 font-semibold">
                  <td className="px-4 py-3">Total Depot</td>
                  <td />
                  <td className="px-2 py-3 text-right tabular-nums">{geld(depotGesamt)}</td>
                  <td className={`px-2 py-3 text-right tabular-nums ${farbe(depot.gewinn)}`}>{geld(depot.gewinn)}</td>
                  <td className={`px-2 py-3 text-right tabular-nums ${farbe(depot.xirr)}`}>{prozent(depot.xirr)}</td>
                  <td />
                  <td />
                  <td className={`px-2 py-3 text-right tabular-nums ${farbe(potenzialGewichtet)}`}>{potenzialGewichtet != null ? prozent(potenzialGewichtet) : ""}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <p className="text-sm text-stone-500">Noch keine Positionen. Lade unten die Dateien von HSBC hoch.</p>
        )}
        <p className="mt-4 text-xs leading-relaxed text-stone-400">
          «KGV» = Kurs-Gewinn-Verhältnis, «Div.-Rendite» = Dividende pro Jahr im Verhältnis zum Kurs. «Gesamt» (unter dem Gewinn) = Gewinn inkl. Dividenden im Verhältnis zu allem, was du gekauft hast. «p. a.» = Rendite pro Jahr unter
          Berücksichtigung, wann du gekauft, verkauft und Dividenden erhalten hast (XIRR). «Ø Kursziel» = durchschnittliches Kursziel
          der Analysten, darunter der Abstand zum heutigen Kurs. Analysten: Anzahl Buy / Hold / Sell aus dem letzten Bericht des Agenten; das Wort oben ist die grösste Gruppe.
          Kein Rat zum Kaufen oder Verkaufen.
        </p>
      </Karte>

      {/* Briefing */}
      <h2 className="mb-3 mt-10 text-xl font-semibold">Briefing</h2>
      <Karte>
        {briefing ? (
          <>
            <p className="font-medium">{briefing.inhalt.titel}</p>
            <p className="mb-3 text-xs text-stone-400">{new Date(`${briefing.zeitraum}T12:00:00Z`).toLocaleDateString("de-CH", { timeZone: "UTC", dateStyle: "full" })}</p>
            <ul className="flex flex-col gap-2 text-sm">
              {briefing.inhalt.punkte.map((p, i) => (
                <li key={i} className="flex gap-2.5">
                  <span
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${p.dringlichkeit === "hoch" ? "bg-rose-600" : p.dringlichkeit === "mittel" ? "bg-amber-500" : "bg-stone-300"}`}
                  />
                  {p.text}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-stone-500">Das erste Briefing kommt am nächsten Morgen um 8 Uhr, sobald Positionen importiert sind.</p>
        )}
      </Karte>

      {/* Konten und Karten */}
      <h2 className="mb-3 mt-10 text-xl font-semibold">Konten und Karten</h2>
      <Konten konten={andereKonten} neuLaden={laden} />

      {/* Limits, Aufträge, Reporto */}
      <h2 className="mb-3 mt-10 text-xl font-semibold">Limits, Aufträge und Reporto</h2>
      <div className="grid gap-3 md:grid-cols-3">
        <Karte>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-500">Deine Limits</p>
          {limits.filter((l) => l.aktiv).length ? (
            <ul className="divide-y divide-stone-100 text-sm">
              {limits
                .filter((l) => l.aktiv)
                .map((l) => (
                  <li key={l.id} className="py-1.5">
                    <a href={`#/wertpapier/${l.wertpapier_id}`} className="font-medium hover:underline">
                      {l.art === "kauf" ? "Kaufen" : "Verkaufen"} {l.wertpapiere?.emisora} bei {l.kurs}
                    </a>
                    <span className="block text-xs text-stone-500">
                      {l.stueck ? `${l.stueck} Stk. · ` : ""}aktuell {l.wertpapiere?.kurs ?? "–"}
                    </span>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="text-sm text-stone-500">Keine. Erfassen kannst du sie in jeder Position; du bekommst eine Meldung, wenn der Kurs erreicht ist.</p>
          )}
        </Karte>
        <Karte>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-500">Offene Aufträge bei HSBC</p>
          {orders.length ? (
            <ul className="divide-y divide-stone-100 text-sm">
              {orders.map((o) => (
                <li key={o.folio} className="py-1.5">
                  <span className="font-medium">
                    {o.art === "kauf" ? "Kauf" : "Verkauf"} {o.stueck} {o.emisora} zu {o.kurs}
                  </span>
                  <span className="block text-xs text-stone-500">
                    bis {datum(o.gueltig_bis)} · {o.status}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-stone-500">Keine (Stand des letzten Imports).</p>
          )}
        </Karte>
        <Karte>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-500">Zinsen aus Reporto (CETES)</p>
          {depot.reportoZins > 0 ? (
            <>
              <p className="text-2xl font-semibold tabular-nums text-emerald-700">{geld(depot.reportoZins, "MXN", 2)}</p>
              <p className="text-xs text-stone-500">
                nach ISR seit {datum(depot.reportoSeit)}
                {depot.reportoSatz != null && <> · Ø {depot.reportoSatz.toFixed(2)} % pro Jahr</>}
              </p>
            </>
          ) : (
            <p className="text-sm text-stone-500">Noch keine Reporto-Bewegungen importiert.</p>
          )}
        </Karte>
      </div>

      {/* Import */}
      <h2 className="mb-3 mt-10 text-xl font-semibold">Dateien von HSBC hochladen</h2>
      <Karte>
        <p className="mb-3 text-sm text-stone-600">
          Im HSBC-Portal exportieren und hier hochladen (mehrere auf einmal möglich): <b>Movimientos Históricos</b> (letzte 90 Tage),{" "}
          <b>Posiciones</b> und <b>Órdenes Vigentes</b>. Doppelte Bewegungen werden erkannt. Am besten alle paar Wochen, damit die
          Historie lückenlos bleibt.
        </p>
        <input
          type="file"
          multiple
          accept=".xlsx"
          onChange={(e) => importieren(e.target.files)}
          className="text-sm file:mr-3 file:rounded file:border-0 file:bg-stone-900 file:px-3 file:py-1.5 file:text-white"
        />
        {meldung && <p className="mt-2 text-sm text-stone-700">{meldung}</p>}
      </Karte>
      <p className="mt-6 text-xs text-stone-400">
        Der Finanz-Agent gibt Informationen und Rechnungen, keine Anlage- oder Steuerberatung, und führt nie Aufträge aus.
        {depot.positionen[0]?.papier.kurs_am && <> Kurse zuletzt {zeit(depot.positionen[0].papier.kurs_am)}.</>}
      </p>
    </Seite>
  );
}

function HeroWert({ titel, wert }: { titel: string; wert: string }) {
  return (
    <div>
      <dt className="text-xs text-stone-400">{titel}</dt>
      <dd className="font-medium tabular-nums">{wert}</dd>
    </div>
  );
}

function Kennzahl({ titel, wert, klasse = "", hinweis }: { titel: string; wert: string; klasse?: string; hinweis?: string }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <p className="text-xs text-stone-500">{titel}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${klasse}`}>{wert}</p>
      {hinweis && <p className="mt-0.5 text-xs text-stone-400">{hinweis}</p>}
    </div>
  );
}

function PositionsZeile({ p, farbe: punkt, anteil }: { p: PositionAuswertung; farbe: string; anteil: number }) {
  const a = analystenVon(p);
  const b = (p.papier.bericht ?? {}) as Record<string, unknown>;
  const kennzahl = (v: unknown, einheit: string) =>
    typeof v === "number" && Number.isFinite(v) ? `${v.toLocaleString("de-CH", { maximumFractionDigits: 1 })}${einheit}` : <span className="text-stone-300">–</span>;
  return (
    <tr className="border-b border-stone-100 align-top hover:bg-stone-50">
      <td className="px-4 py-3">
        <a href={`#/wertpapier/${p.papier.id}`} className="flex items-start gap-2">
          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: punkt }} />
          <span>
            <span className="font-semibold hover:underline">{p.papier.emisora}</span>
            <span className="block text-xs text-stone-400">
              {p.stueck.toLocaleString("de-CH")} Stück · {(anteil * 100).toFixed(1)} %{p.geschaetzt ? " · teils geschätzt" : ""}
            </span>
          </span>
        </a>
      </td>
      <td className="px-2 py-3 text-right tabular-nums">
        {p.kurs?.toLocaleString("de-CH", { maximumFractionDigits: 2 }) ?? "–"}
        {p.veraenderungHeute != null && <span className={`block text-xs ${farbe(p.veraenderungHeute)}`}>{prozent(p.veraenderungHeute)} heute</span>}
      </td>
      <td className="px-2 py-3 text-right font-medium tabular-nums">{geld(p.rendite.wert)}</td>
      <td className={`px-2 py-3 text-right tabular-nums ${farbe(p.rendite.gewinn)}`}>
        {geld(p.rendite.gewinn)}
        <span className="block text-xs">{prozent(p.rendite.renditeProzent)}</span>
        {p.rendite.dividenden > 0 && <span className="block text-xs text-stone-400">davon Div. {geld(p.rendite.dividenden)}</span>}
      </td>
      <td className={`px-2 py-3 text-right tabular-nums ${farbe(p.rendite.xirr)}`}>
        {p.rendite.xirr != null ? prozent(p.rendite.xirr) : <span className="text-xs text-stone-400" title="Weniger als 2 Wochen im Depot: Hochrechnung aufs Jahr wäre unsinnig">zu kurz</span>}
      </td>
      <td className="px-2 py-3 text-right tabular-nums">{kennzahl(b.kgv, "")}</td>
      <td className="px-2 py-3 text-right tabular-nums">{kennzahl(b.dividendenrendite, " %")}</td>
      <td className="px-2 py-3 text-right tabular-nums">
        {a.kursziel != null ? (
          <>
            {a.kursziel.toLocaleString("de-CH", { maximumFractionDigits: 2 })}
            <span className={`block text-xs ${farbe(a.potenzial)}`}>{prozent(a.potenzial)}</span>
          </>
        ) : (
          <span className="text-stone-300">–</span>
        )}
      </td>
      <td className="px-4 py-3">
        <AnalystenBalken a={a} />
      </td>
    </tr>
  );
}

const URTEIL_STIL = {
  Buy: "bg-emerald-100 text-emerald-800",
  Hold: "bg-amber-100 text-amber-800",
  Sell: "bg-rose-100 text-rose-800",
} as const;

/** Buy / Hold / Sell als gestapelter Balken mit Anzahl und Mehrheitsurteil. */
export function AnalystenBalken({ a }: { a: Analysten }) {
  if (!a.summe) return <span className="text-xs text-stone-300">keine Daten</span>;
  const teil = (n: number) => `${(n / a.summe) * 100}%`;
  return (
    <div className="w-44">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${URTEIL_STIL[a.urteil!]}`}>{a.urteil}</span>
        <span className="text-[11px] text-stone-400">
          {a.urteil === "Buy" ? a.kaufen : a.urteil === "Sell" ? a.verkaufen : a.halten} von {a.summe} Analysten
        </span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-stone-100">
        <div className="bg-emerald-500" style={{ width: teil(a.kaufen) }} />
        <div className="bg-amber-400" style={{ width: teil(a.halten) }} />
        <div className="bg-rose-500" style={{ width: teil(a.verkaufen) }} />
      </div>
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-stone-500">
        <span>Buy {a.kaufen}</span>
        <span>Hold {a.halten}</span>
        <span>Sell {a.verkaufen}</span>
      </div>
    </div>
  );
}

/** Barguthaben im Depot: von Sven selbst eingetragen (liegt nicht immer im Reporto). */
function CashZeile({
  konto,
  anteil,
  reporto,
  reportoAm,
  neuLaden,
}: {
  konto: Konto | null;
  anteil: number;
  reporto: number;
  reportoAm: string | null;
  neuLaden: () => void;
}) {
  const [bearbeiten, setBearbeiten] = useState(false);
  const [wert, setWert] = useState(String(konto?.saldo ?? ""));

  async function speichern() {
    const n = Number(wert.replace(/[^\d.-]/g, ""));
    if (!Number.isFinite(n)) return;
    if (konto) await saldoSetzen(konto, n);
    else await supabase.from("konten").insert({ name: "Cash im Depot (Casa de Bolsa)", institut: "HSBC", typ: "konto", saldo: n });
    setBearbeiten(false);
    neuLaden();
  }

  return (
    <tr className="border-b border-stone-100 bg-stone-50/60 align-top">
      <td className="px-4 py-3" colSpan={2}>
        <span className="flex items-start gap-2">
          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: CASH_FARBE }} />
          <span>
            <span className="font-semibold">Barguthaben im Depot</span>
            <span className="block text-xs text-stone-400">
              {konto ? `Stand ${datum(konto.saldo_am)} · ${(anteil * 100).toFixed(1)} %` : "noch nicht eingetragen"}
              {reporto > 0 && ` · letzter Reporto ${geld(reporto)} am ${datum(reportoAm)}`}
            </span>
          </span>
        </span>
      </td>
      <td className="px-2 py-3 text-right font-medium tabular-nums">
        {bearbeiten ? (
          <span className="flex items-center justify-end gap-1">
            <input
              autoFocus
              value={wert}
              onChange={(e) => setWert(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && speichern()}
              className="w-28 rounded border border-stone-300 px-2 py-1 text-right text-sm"
            />
            <Knopf onClick={speichern} primaer>
              OK
            </Knopf>
          </span>
        ) : (
          <button onClick={() => setBearbeiten(true)} className="tabular-nums hover:underline" title="Anklicken zum Ändern">
            {konto ? geld(konto.saldo) : "eintragen"}
          </button>
        )}
      </td>
      <td colSpan={6} />
    </tr>
  );
}

export function LimitFormular({ wertpapierId, fertig }: { wertpapierId: string; fertig: () => void }) {
  const [art, setArt] = useState<"kauf" | "verkauf">("verkauf");
  const [kurs, setKurs] = useState("");
  const [stueck, setStueck] = useState("");
  const [notiz, setNotiz] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        await supabase.from("kurs_limits").insert({
          wertpapier_id: wertpapierId,
          art,
          kurs: Number(kurs),
          stueck: stueck ? Number(stueck) : null,
          notiz: notiz || null,
        });
        setKurs("");
        setStueck("");
        setNotiz("");
        fertig();
      }}
      className="flex flex-wrap items-end gap-2 text-sm"
    >
      <select value={art} onChange={(e) => setArt(e.target.value as "kauf" | "verkauf")} className="rounded border border-stone-300 px-2 py-1.5">
        <option value="verkauf">Verkaufen ab</option>
        <option value="kauf">Kaufen bis</option>
      </select>
      <input required type="number" step="0.0001" value={kurs} onChange={(e) => setKurs(e.target.value)} placeholder="Kurs" className="w-28 rounded border border-stone-300 px-2 py-1.5" />
      <input type="number" step="1" value={stueck} onChange={(e) => setStueck(e.target.value)} placeholder="Stück (optional)" className="w-36 rounded border border-stone-300 px-2 py-1.5" />
      <input value={notiz} onChange={(e) => setNotiz(e.target.value)} placeholder="Notiz" className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1.5" />
      <Knopf onClick={() => {}} typ="submit" primaer>
        Limit setzen
      </Knopf>
    </form>
  );
}
