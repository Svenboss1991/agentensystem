import { useCallback, useEffect, useState } from "react";
import { AnalystenBalken, analystenVon } from "./Finanzen";
import { beobachten, prozent, tickerVorschlag, type PositionAuswertung, type Wertpapier } from "./lib/finanzDaten";
import type { PapierTyp } from "./lib/hsbcImport";
import { supabase } from "./lib/supabase";
import { Karte, Knopf } from "./ui";

const farbe = (n: number | null | undefined) => (n == null ? "text-stone-400" : n >= 0 ? "text-emerald-700" : "text-rose-700");
const zahl = (v: unknown, einheit = "") =>
  typeof v === "number" && Number.isFinite(v) ? `${v.toLocaleString("de-CH", { maximumFractionDigits: 1 })}${einheit}` : null;

/** Titel beobachten, ohne sie zu besitzen: Kurs, Entwicklung seit Aufnahme, Kennzahlen und Analysten. */
export default function Watchlist() {
  const [liste, setListe] = useState<Wertpapier[]>([]);
  const [neu, setNeu] = useState(false);

  const laden = useCallback(async () => {
    const { data } = await supabase.from("wertpapiere").select("*").eq("beobachten", true).order("emisora");
    setListe((data ?? []) as Wertpapier[]);
  }, []);

  useEffect(() => {
    laden();
  }, [laden]);

  async function entfernen(w: Wertpapier) {
    if (!window.confirm(`${w.emisora} von der Watchlist nehmen?`)) return;
    await beobachten(w.emisora, w.typ, w.ticker, false);
    laden();
  }

  return (
    <Karte>
      {liste.length ? (
        <div className="-mx-4 overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm">
            <thead>
              <tr className="border-b border-stone-200 text-left text-[11px] uppercase tracking-wide text-stone-500">
                <th className="px-4 pb-2 font-medium">Titel</th>
                <th className="px-2 pb-2 text-right font-medium">Kurs</th>
                <th className="px-2 pb-2 text-right font-medium">Seit Aufnahme</th>
                <th className="px-2 pb-2 text-right font-medium">KGV</th>
                <th className="px-2 pb-2 text-right font-medium">Div.-Rendite</th>
                <th className="px-2 pb-2 text-right font-medium">Ø Kursziel</th>
                <th className="px-4 pb-2 font-medium">Analysten</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {liste.map((w) => {
                const a = analystenVon({ papier: w, kurs: w.kurs } as PositionAuswertung);
                const b = (w.bericht ?? {}) as Record<string, unknown>;
                const heute = w.kurs && w.kurs_vortag ? w.kurs / w.kurs_vortag - 1 : null;
                const seither = w.kurs && w.kurs_beim_hinzufuegen ? w.kurs / w.kurs_beim_hinzufuegen - 1 : null;
                return (
                  <tr key={w.id} className="border-b border-stone-100 align-top hover:bg-stone-50">
                    <td className="px-4 py-3">
                      <a href={`#/wertpapier/${w.id}`} className="font-semibold hover:underline">
                        {w.emisora}
                      </a>
                      <span className="block text-xs text-stone-400">
                        {[w.name ?? (b.name as string | undefined), w.beobachtet_seit && `seit ${new Date(`${w.beobachtet_seit}T12:00:00Z`).toLocaleDateString("de-CH", { timeZone: "UTC" })}`]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {w.kurs?.toLocaleString("de-CH", { maximumFractionDigits: 2 }) ?? <span className="text-xs text-stone-400">Kurs folgt</span>}
                      {heute != null && <span className={`block text-xs ${farbe(heute)}`}>{prozent(heute)} heute</span>}
                    </td>
                    <td className={`px-2 py-3 text-right tabular-nums ${farbe(seither)}`}>{seither != null ? prozent(seither) : "–"}</td>
                    <td className="px-2 py-3 text-right tabular-nums">{zahl(b.kgv) ?? <span className="text-stone-300">–</span>}</td>
                    <td className="px-2 py-3 text-right tabular-nums">{zahl(b.dividendenrendite, " %") ?? <span className="text-stone-300">–</span>}</td>
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
                      {w.bericht_am ? <AnalystenBalken a={a} /> : <span className="text-xs text-stone-400">Recherche läuft …</span>}
                    </td>
                    <td className="py-3 pr-4 text-right">
                      <button onClick={() => entfernen(w)} className="text-xs text-stone-400 hover:text-rose-700" title="Von der Watchlist nehmen">
                        entfernen
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-stone-500">Noch nichts auf der Watchlist.</p>
      )}
      <div className="mt-4">
        {neu ? (
          <NeuerTitel
            fertig={() => {
              setNeu(false);
              laden();
            }}
          />
        ) : (
          <Knopf onClick={() => setNeu(true)}>+ Titel beobachten</Knopf>
        )}
      </div>
      <p className="mt-3 text-xs text-stone-400">
        Lupita holt Kurse während der Börsenzeit und recherchiert Kennzahlen und Analysten (10–30 Minuten nach dem Hinzufügen). In
        jedem Titel kannst du ein Kauflimit setzen; du bekommst eine Meldung, wenn der Kurs es erreicht.
      </p>
    </Karte>
  );
}

function NeuerTitel({ fertig }: { fertig: () => void }) {
  const [emisora, setEmisora] = useState("");
  const [typ, setTyp] = useState<PapierTyp>("aktie");
  const [ticker, setTicker] = useState("");
  const [fehler, setFehler] = useState("");
  const vorschlag = emisora.trim() ? tickerVorschlag(emisora.trim().toUpperCase(), typ) : null;
  const feld = "rounded border border-stone-300 px-2 py-1.5 text-sm";

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await beobachten(emisora, typ, ticker.trim() || null);
          fertig();
        } catch (err) {
          setFehler(err instanceof Error ? err.message : String(err));
        }
      }}
      className="flex flex-wrap items-end gap-2"
    >
      <label className="text-xs text-stone-500">
        Kürzel wie bei HSBC
        <input required value={emisora} onChange={(e) => setEmisora(e.target.value)} placeholder="z. B. WALMEX * oder AMX B" className={`${feld} mt-1 block w-44`} />
      </label>
      <label className="text-xs text-stone-500">
        Art
        <select value={typ} onChange={(e) => setTyp(e.target.value as PapierTyp)} className={`${feld} mt-1 block`}>
          <option value="aktie">Aktie</option>
          <option value="etf">ETF</option>
          <option value="fonds">Fonds</option>
          <option value="sonstiges">Sonstiges</option>
        </select>
      </label>
      <label className="text-xs text-stone-500">
        Yahoo-Ticker (optional)
        <input value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder={vorschlag ?? "z. B. WALMEX.MX"} className={`${feld} mt-1 block w-40`} />
      </label>
      <Knopf onClick={() => {}} typ="submit" primaer>
        Hinzufügen
      </Knopf>
      <Knopf onClick={fertig}>Abbrechen</Knopf>
      {fehler && <p className="w-full text-sm text-rose-700">{fehler}</p>}
    </form>
  );
}
