import { useCallback, useEffect, useState } from "react";
import { LimitFormular } from "./Finanzen";
import { depotLaden, geld, prozent, type PositionAuswertung, type Tx, type Wertpapier } from "./lib/finanzDaten";
import { bereich, boosterAuszahlung, boosterSchwellen, erwarteteAuszahlung, wahrscheinlichkeitUnter, type Produkt } from "./lib/produkt";
import { supabase, zeit } from "./lib/supabase";
import { Seite } from "./Seite";
import { Karte, Knopf } from "./ui";

interface Bericht {
  name?: string | null;
  sektor?: string | null;
  beschreibung?: string | null;
  kgv?: number | null;
  kgv_erwartet?: number | null;
  kbv?: number | null;
  dividendenrendite?: number | null;
  dividende_pro_jahr?: number | null;
  naechste_dividende_ex?: string | null;
  naechste_dividende_zahltag?: string | null;
  naechste_dividende_betrag?: number | null;
  marktkapitalisierung?: string | null;
  hoch_52w?: number | null;
  tief_52w?: number | null;
  naechste_zahlen?: string | null;
  analysten_kaufen?: number | null;
  analysten_halten?: number | null;
  analysten_verkaufen?: number | null;
  kursziel?: number | null;
  analysten_zusammenfassung?: string | null;
  news?: { datum?: string | null; titel: string; bedeutung?: string | null }[];
  chancen?: string[];
  risiken?: string[];
  steuer?: string[];
  quellen?: { titel?: string | null; url: string }[];
}

interface Limit {
  id: string;
  art: "kauf" | "verkauf";
  kurs: number;
  stueck: number | null;
  notiz: string | null;
  aktiv: boolean;
  ausgeloest_am: string | null;
}

const datum = (iso: string | null | undefined) =>
  iso ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("de-CH", { timeZone: "UTC" }) : "–";
const zahl = (n: number | null | undefined, stellen = 2) =>
  n == null ? "–" : n.toLocaleString("de-CH", { minimumFractionDigits: stellen, maximumFractionDigits: stellen });

export function WertpapierSeite({ id }: { id: string }) {
  const [pos, setPos] = useState<PositionAuswertung | null>(null);
  const [papier, setPapier] = useState<Wertpapier | null>(null);
  const [tx, setTx] = useState<Tx[]>([]);
  const [limits, setLimits] = useState<Limit[]>([]);

  const laden = useCallback(async () => {
    const [d, w, l] = await Promise.all([
      depotLaden(),
      supabase.from("wertpapiere").select("*").eq("id", id).single(),
      supabase.from("kurs_limits").select("id, art, kurs, stueck, notiz, aktiv, ausgeloest_am").eq("wertpapier_id", id).order("erstellt_am", { ascending: false }),
    ]);
    setPos(d.positionen.find((p) => p.papier.id === id) ?? null);
    setPapier(w.data as Wertpapier);
    setTx(d.transaktionen.filter((t) => t.wertpapier_id === id).reverse());
    setLimits((l.data ?? []) as Limit[]);
  }, [id]);

  useEffect(() => {
    laden();
  }, [laden]);

  if (!papier) return <Seite titel="Wertpapier">Lädt …</Seite>;
  const b = (papier.bericht ?? {}) as Bericht;
  const r = pos?.rendite;
  const analysten = (b.analysten_kaufen ?? 0) + (b.analysten_halten ?? 0) + (b.analysten_verkaufen ?? 0);

  return (
    <Seite titel={papier.emisora}>
      <p className="-mt-4 mb-6 text-stone-500">
        {[b.name ?? papier.name, b.sektor, papier.typ].filter(Boolean).join(" · ")}
      </p>

      {/* Meine Position */}
      <Karte>
        <p className="mb-2 font-semibold">Meine Position</p>
        {pos && r ? (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
            <Feld titel="Stück" wert={pos.stueck.toLocaleString("de-CH")} />
            <Feld titel={`Kurs (${pos.kursQuelle === "live" ? "aktuell" : "Stand Bank"})`} wert={zahl(pos.kurs, 4)} />
            <Feld titel="Wert" wert={geld(r.wert)} />
            <Feld titel="Gekauft für (inkl. Kommission)" wert={geld(r.gekauft)} />
            <Feld titel="Verkaufserlöse" wert={geld(r.verkauft)} />
            <Feld titel="Dividenden (netto)" wert={geld(r.dividenden, "MXN", 2)} />
            <Feld titel="Gewinn gesamt" wert={geld(r.gewinn)} />
            <Feld titel="Rendite gesamt / pro Jahr" wert={`${prozent(r.renditeProzent)} / ${prozent(r.xirr)}`} />
            {pos.bank && (
              <Feld
                titel="Zum Vergleich: Bank (Durchschnittspreis)"
                wert={`${zahl(Number(pos.bank.kosten_durchschnitt), 4)} · Plus ${geld(Number(pos.bank.wert ?? 0) - Number(pos.bank.kosten_bank ?? 0))}`}
              />
            )}
          </dl>
        ) : (
          <p className="text-sm text-stone-500">Nicht im Bestand.</p>
        )}
        {pos?.geschaetzt && (
          <p className="mt-3 text-xs text-amber-700">
            {pos.geschaetzt.stueck.toLocaleString("de-CH")} Stück stammen aus der Zeit vor dem ersten Import. Sie sind mit dem
            Durchschnittspreis der Bank zum {datum(pos.geschaetzt.datum)} angesetzt. Erfasse unten die echten Käufe, dann wird die
            Rendite genau.
          </p>
        )}
      </Karte>

      {papier.produkt && <ProduktKarte p={papier.produkt} stueck={pos?.stueck ?? 0} />}

      {/* Kennzahlen und Analysten */}
      <div className="mb-2 mt-8 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Kennzahlen und Analysten</h2>
        <span className="text-xs text-stone-500">
          {papier.bericht_am ? `Stand ${zeit(papier.bericht_am)}` : "noch kein Bericht"}
          <button
            onClick={async () => {
              await supabase.from("wertpapiere").update({ bericht_am: null, bericht_fehler: null }).eq("id", id);
              await laden();
            }}
            className="ml-3 underline"
          >
            neu recherchieren
          </button>
        </span>
      </div>
      {papier.bericht_fehler && <p className="mb-2 text-sm text-red-700">{papier.bericht_fehler}</p>}
      {!papier.bericht_am && (
        <p className="mb-2 text-sm text-stone-500">
          Claude recherchiert im Hintergrund (Kennzahlen, Analysten, Dividenden, News, Steuern). Das dauert meist 10–30 Minuten.
        </p>
      )}
      {papier.bericht && (
        <>
          <Karte>
            {b.beschreibung && <p className="mb-3 text-sm">{b.beschreibung}</p>}
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
              <Feld titel="KGV" wert={zahl(b.kgv, 1)} />
              <Feld titel="KGV erwartet" wert={zahl(b.kgv_erwartet, 1)} />
              <Feld titel="KBV" wert={zahl(b.kbv, 1)} />
              <Feld titel="Marktkapitalisierung" wert={b.marktkapitalisierung ?? "–"} />
              <Feld titel="Dividendenrendite" wert={b.dividendenrendite != null ? `${zahl(b.dividendenrendite, 1)} %` : "–"} />
              <Feld titel="Dividende pro Jahr" wert={zahl(b.dividende_pro_jahr)} />
              <Feld
                titel="Nächste Dividende"
                wert={b.naechste_dividende_ex ? `Ex ${datum(b.naechste_dividende_ex)}${b.naechste_dividende_betrag ? ` · ${zahl(b.naechste_dividende_betrag)}` : ""}` : "–"}
              />
              <Feld titel="Zahltag" wert={datum(b.naechste_dividende_zahltag)} />
              <Feld titel="52 Wochen tief / hoch" wert={`${zahl(b.tief_52w)} / ${zahl(b.hoch_52w)}`} />
              <Feld titel="Nächste Quartalszahlen" wert={datum(b.naechste_zahlen)} />
              <Feld titel="Kursziel Analysten" wert={zahl(b.kursziel)} />
              <Feld
                titel="Kaufen / Halten / Verkaufen"
                wert={analysten ? `${b.analysten_kaufen ?? 0} / ${b.analysten_halten ?? 0} / ${b.analysten_verkaufen ?? 0}` : "–"}
              />
            </dl>
            {b.analysten_zusammenfassung && (
              <p className="mt-3 text-sm">
                <span className="font-medium">Analysten: </span>
                {b.analysten_zusammenfassung}
              </p>
            )}
          </Karte>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Liste titel="Chancen" punkte={b.chancen} />
            <Liste titel="Risiken" punkte={b.risiken} />
          </div>
          <div className="mt-4">
            <Liste titel="Steuerliche Hinweise (Mexiko)" punkte={b.steuer} />
          </div>
          {!!b.news?.length && (
            <div className="mt-4">
              <Karte>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-stone-500">News</p>
                <ul className="text-sm">
                  {b.news.map((n, i) => (
                    <li key={i} className="border-t border-stone-100 py-1.5 first:border-0">
                      <span className="mr-2 text-xs text-stone-400">{n.datum ? datum(n.datum) : ""}</span>
                      {n.titel}
                      {n.bedeutung && <span className="block text-xs text-stone-500">{n.bedeutung}</span>}
                    </li>
                  ))}
                </ul>
              </Karte>
            </div>
          )}
          {!!b.quellen?.length && (
            <p className="mt-2 text-xs text-stone-400">
              Quellen:{" "}
              {b.quellen.map((q, i) => (
                <a key={i} href={q.url} target="_blank" rel="noreferrer" className="mr-2 underline">
                  {q.titel || new URL(q.url).hostname}
                </a>
              ))}
            </p>
          )}
        </>
      )}

      {/* Limits */}
      <h2 className="mb-2 mt-8 text-lg font-semibold">Meine Limits</h2>
      <Karte>
        <p className="mb-3 text-xs text-stone-500">Wird ein Limit erreicht, erscheint eine Meldung unter «Muss ich handeln?». Der Agent kauft und verkauft nie selbst.</p>
        <LimitFormular wertpapierId={id} fertig={laden} />
        {limits.length > 0 && (
          <ul className="mt-3 text-sm">
            {limits.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 py-1.5">
                <span className={l.aktiv ? "" : "text-stone-400 line-through"}>
                  {l.art === "kauf" ? "Kaufen bis" : "Verkaufen ab"} {l.kurs} {l.stueck ? `(${l.stueck} Stk.)` : ""} {l.notiz ? `· ${l.notiz}` : ""}
                </span>
                <span className="flex gap-3 text-xs text-stone-500">
                  {l.ausgeloest_am && <>erreicht {zeit(l.ausgeloest_am)}</>}
                  <button
                    onClick={async () => {
                      await supabase.from("kurs_limits").delete().eq("id", l.id);
                      await laden();
                    }}
                    className="underline"
                  >
                    löschen
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Karte>

      {/* Bewegungen und frühere Käufe */}
      <h2 className="mb-2 mt-8 text-lg font-semibold">Käufe, Verkäufe, Dividenden</h2>
      <Karte>
        <FruehererKauf papier={papier} fertig={laden} />
        {tx.length ? (
          <table className="mt-3 w-full text-sm">
            <tbody>
              {tx.map((t) => (
                <tr key={t.id} className="border-t border-stone-100">
                  <td className="py-1.5 pr-2 text-stone-500">{datum(t.datum)}</td>
                  <td className="py-1.5 pr-2">
                    {t.typ === "kauf" ? "Kauf" : t.typ === "verkauf" ? "Verkauf" : "Dividende"}
                    {t.quelle === "sven" && <span className="ml-1 text-xs text-stone-400">(von Hand)</span>}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{t.stueck ? `${Number(t.stueck).toLocaleString("de-CH")} × ${zahl(t.kurs, 2)}` : ""}</td>
                  <td className="py-1.5 text-right tabular-nums">{geld(t.betrag, "MXN", 2)}</td>
                  <td className="py-1.5 pl-2 text-right text-xs text-stone-400">
                    {t.quelle === "sven" && (
                      <button
                        onClick={async () => {
                          await supabase.from("depot_transaktionen").delete().eq("id", t.id);
                          await laden();
                        }}
                        className="underline"
                      >
                        löschen
                      </button>
                    )}
                    {t.isr ? `ISR ${zahl(t.isr)}` : t.kommission ? `Komm. ${zahl(Number(t.kommission) + Number(t.iva ?? 0))}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-3 text-sm text-stone-500">Noch keine Bewegungen importiert.</p>
        )}
      </Karte>

      {/* Einstellungen */}
      <h2 className="mb-2 mt-8 text-lg font-semibold">Einstellungen</h2>
      <Karte>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            await supabase
              .from("wertpapiere")
              .update({ ticker: (f.get("ticker") as string).trim() || null, typ: f.get("typ"), notiz: (f.get("notiz") as string) || null })
              .eq("id", id);
            await laden();
          }}
          className="flex flex-wrap items-end gap-2 text-sm"
        >
          <label className="text-xs text-stone-500">
            Ticker für Kurse (Yahoo Finance)
            <input name="ticker" defaultValue={papier.ticker ?? ""} placeholder="z. B. ASURB.MX" className="mt-1 block w-40 rounded border border-stone-300 px-2 py-1.5 text-sm text-stone-900" />
          </label>
          <label className="text-xs text-stone-500">
            Art
            <select name="typ" defaultValue={papier.typ} className="mt-1 block rounded border border-stone-300 px-2 py-1.5 text-sm text-stone-900">
              <option value="aktie">Aktie</option>
              <option value="etf">ETF</option>
              <option value="fonds">Fonds</option>
              <option value="note">Strukturierte Note</option>
              <option value="sonstiges">Sonstiges</option>
            </select>
          </label>
          <label className="min-w-0 flex-1 text-xs text-stone-500">
            Notiz
            <input name="notiz" defaultValue={papier.notiz ?? ""} className="mt-1 block w-full rounded border border-stone-300 px-2 py-1.5 text-sm text-stone-900" />
          </label>
          <Knopf onClick={() => {}} typ="submit">
            Speichern
          </Knopf>
        </form>
        <p className="mt-2 text-xs text-stone-400">
          Ohne Ticker (z. B. bei Fonds) gilt der Kurs aus dem letzten Import «Posiciones».
        </p>
      </Karte>
    </Seite>
  );
}

function FruehererKauf({ papier, fertig }: { papier: Wertpapier; fertig: () => void }) {
  const [offen, setOffen] = useState(false);
  const [datumWert, setDatum] = useState("");
  const [stueck, setStueck] = useState("");
  const [kurs, setKurs] = useState("");
  const [kosten, setKosten] = useState("");
  if (!offen)
    return (
      <button onClick={() => setOffen(true)} className="text-sm underline">
        + Früheren Kauf von Hand erfassen
      </button>
    );
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const betrag = Number(stueck) * Number(kurs) + Number(kosten || 0);
        await supabase.from("depot_transaktionen").insert({
          depot: "HSBC",
          datum: datumWert,
          folio: `manuell-${crypto.randomUUID()}`,
          konzept: "COMPRA (von Hand)",
          typ: "kauf",
          emisora: papier.emisora,
          wertpapier_id: papier.id,
          stueck: Number(stueck),
          kurs: Number(kurs),
          betrag,
          kommission: kosten ? Number(kosten) : null,
          quelle: "sven",
        });
        setOffen(false);
        fertig();
      }}
      className="flex flex-wrap items-end gap-2 text-sm"
    >
      <label className="text-xs text-stone-500">
        Datum
        <input required type="date" value={datumWert} onChange={(e) => setDatum(e.target.value)} className="mt-1 block rounded border border-stone-300 px-2 py-1.5 text-sm" />
      </label>
      <label className="text-xs text-stone-500">
        Stück
        <input required type="number" step="any" value={stueck} onChange={(e) => setStueck(e.target.value)} className="mt-1 block w-24 rounded border border-stone-300 px-2 py-1.5 text-sm" />
      </label>
      <label className="text-xs text-stone-500">
        Preis pro Stück
        <input required type="number" step="any" value={kurs} onChange={(e) => setKurs(e.target.value)} className="mt-1 block w-28 rounded border border-stone-300 px-2 py-1.5 text-sm" />
      </label>
      <label className="text-xs text-stone-500">
        Kommission + IVA
        <input type="number" step="any" value={kosten} onChange={(e) => setKosten(e.target.value)} className="mt-1 block w-28 rounded border border-stone-300 px-2 py-1.5 text-sm" />
      </label>
      <Knopf onClick={() => {}} typ="submit" primaer>
        Speichern
      </Knopf>
      <Knopf onClick={() => setOffen(false)}>Abbrechen</Knopf>
    </form>
  );
}

function Feld({ titel, wert }: { titel: string; wert: string }) {
  return (
    <div>
      <dt className="text-xs text-stone-500">{titel}</dt>
      <dd className="tabular-nums">{wert}</dd>
    </div>
  );
}

function Liste({ titel, punkte }: { titel: string; punkte?: string[] }) {
  if (!punkte?.length) return null;
  return (
    <Karte>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-stone-500">{titel}</p>
      <ul className="ml-4 list-disc text-sm">
        {punkte.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ul>
    </Karte>
  );
}

function ProduktKarte({ p, stueck }: { p: Produkt; stueck: number }) {
  const kurs = p.basis_kurs ?? null;
  const { hoechstAb, mindestUnter } = boosterSchwellen(p);
  const jahre = Math.max(0, (Date.parse(`${p.stichtag}T20:00:00Z`) - Date.now()) / (365.25 * 86_400_000));
  const sigma = 0.24; // angenommene Schwankung pro Jahr
  const wert = (s: number) => boosterAuszahlung(p, s);
  const grenzen = [mindestUnter, p.startkurs, ...(p.vergleich_schwelle ? [p.vergleich_schwelle] : []), hoechstAb];
  const unter = (x: number) => (kurs ? wahrscheinlichkeitUnter(x, kurs, sigma, jahre) : null);
  const zeilen: { bereich: string; auszahlung: string; w: number | null }[] = [
    { bereich: `unter ${zahl(mindestUnter)}`, auszahlung: `${zahl(p.mindest, 0)} (Untergrenze)`, w: unter(mindestUnter) },
    {
      bereich: `${zahl(mindestUnter)} – ${zahl(p.startkurs)}`,
      auszahlung: "Verlust 1:1 wie der Basiswert",
      w: kurs ? (unter(p.startkurs)! - unter(mindestUnter)!) : null,
    },
    ...(p.vergleich_schwelle
      ? [
          {
            bereich: `${zahl(p.startkurs)} – ${zahl(p.vergleich_schwelle)}`,
            auszahlung: `Gewinn, aber unter ${p.vergleich_text ?? "Vergleich"}`,
            w: kurs ? unter(p.vergleich_schwelle)! - unter(p.startkurs)! : null,
          },
          {
            bereich: `${zahl(p.vergleich_schwelle)} – ${zahl(hoechstAb)}`,
            auszahlung: `Zielbereich: ${p.partizipation * 100} % des Anstiegs`,
            w: kurs ? unter(hoechstAb)! - unter(p.vergleich_schwelle)! : null,
          },
        ]
      : [
          {
            bereich: `${zahl(p.startkurs)} – ${zahl(hoechstAb)}`,
            auszahlung: `${p.partizipation * 100} % des Anstiegs`,
            w: kurs ? unter(hoechstAb)! - unter(p.startkurs)! : null,
          },
        ]),
    { bereich: `ab ${zahl(hoechstAb)}`, auszahlung: `${zahl(p.hoechst, 0)} (Maximum)`, w: kurs ? 1 - unter(hoechstAb)! : null },
  ];

  return (
    <>
      <h2 className="mb-2 mt-8 text-lg font-semibold">Produkt: {p.bezeichnung ?? "Strukturiertes Produkt"}</h2>
      <Karte>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <Feld titel="Basiswert" wert={`${p.basiswert} (${p.basis_ticker})`} />
          <Feld titel="Emittent" wert={p.emittent ?? "–"} />
          <Feld titel="Startkurs" wert={`${zahl(p.startkurs)} ${p.basis_waehrung ?? ""}`} />
          <Feld titel="Stichtag / Auszahlung" wert={`${datum(p.stichtag)} / ${datum(p.auszahlung)}`} />
          <Feld titel="Kurs heute" wert={kurs ? `${zahl(kurs)} (${prozent(kurs / p.startkurs - 1)})` : "–"} />
          <Feld titel="Bereich heute" wert={kurs ? bereich(p, kurs) : "–"} />
          <Feld titel="Wert, wenn heute Stichtag wäre" wert={kurs ? `${zahl(wert(kurs))} pro Titel · ${geld(wert(kurs) * stueck)}` : "–"} />
          <Feld
            titel="Erwartungswert am Stichtag"
            wert={kurs ? `${zahl(erwarteteAuszahlung(p, kurs, sigma, jahre))} · ${geld(erwarteteAuszahlung(p, kurs, sigma, jahre) * stueck)}` : "–"}
          />
        </dl>
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-stone-500">
              <th className="pb-1 font-normal">{p.basiswert} am Stichtag</th>
              <th className="pb-1 font-normal">Auszahlung pro {p.nominal}</th>
              <th className="pb-1 text-right font-normal">Wahrscheinlichkeit</th>
            </tr>
          </thead>
          <tbody>
            {zeilen.map((z) => (
              <tr key={z.bereich} className="border-t border-stone-100">
                <td className="py-1.5 pr-2 tabular-nums">{z.bereich}</td>
                <td className="py-1.5 pr-2">{z.auszahlung}</td>
                <td className="py-1.5 text-right tabular-nums">{z.w == null ? "–" : `${Math.round(z.w * 100)} %`}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-stone-400">
          Wahrscheinlichkeiten: einfaches Modell ohne Trend, Schwankung {Math.round(sigma * 100)} % pro Jahr, ab heutigem Kurs. Richtwerte,
          entscheidend ist allein der Schlusskurs am Stichtag. Grenzen: {grenzen.map((g) => zahl(g)).join(" · ")}.
          {p.basis_kurs_am && <> Kurs {p.basiswert} vom {zeit(p.basis_kurs_am)}.</>}
        </p>
        {!!p.termine?.length && (
          <div className="mt-4">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-stone-500">Termine</p>
            <ul className="text-sm">
              {[...p.termine]
                .sort((a, b) => a.datum.localeCompare(b.datum))
                .map((t) => (
                  <li key={t.datum + t.text} className={t.datum < new Date().toISOString().slice(0, 10) ? "text-stone-400" : ""}>
                    <span className="mr-2 tabular-nums">{datum(t.datum)}</span>
                    {t.text}
                  </li>
                ))}
            </ul>
          </div>
        )}
        {p.beschreibung && (
          <div className="mt-4 flex flex-col gap-2 border-t border-stone-100 pt-3 text-sm">
            {p.beschreibung.split(/\n\s*\n/).map((absatz, i) => (
              <p key={i} className="whitespace-pre-line">
                {absatz}
              </p>
            ))}
          </div>
        )}
      </Karte>
    </>
  );
}
