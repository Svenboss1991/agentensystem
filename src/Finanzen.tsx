import readXlsxFile from "read-excel-file/browser";
import { useCallback, useEffect, useState } from "react";
import Konten from "./Konten";
import { depotLaden, geld, heute, hsbcImportieren, kontenLaden, prozent, type Depot, type Konto } from "./lib/finanzDaten";
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

const farbe = (n: number | null | undefined) => (n == null ? "" : n >= 0 ? "text-green-700" : "text-red-700");

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

  const jahre = ziel ? (Date.parse(ziel.bis) - Date.parse(heute())) / (365.25 * 86_400_000) : 0;
  // Cash im Depot ist ein eigenes Konto (HSBC legt es nicht immer im Reporto an); darum hier nur die Positionen.
  const depotGesamt = depot.wert;
  const kontenSumme = konten.reduce((s, k) => s + k.saldo, 0);
  const netto = depotGesamt + kontenSumme;
  const z = ziel ? zielRechnung(netto, ziel.betrag, jahre, depot.xirr) : null;
  const fortschritt = ziel ? Math.max(0, Math.min(1, netto / ziel.betrag)) : 0;

  return (
    <Seite titel="Finanzen">
      {/* Überblick */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kennzahl titel="Nettovermögen" wert={geld(netto)} hinweis="Depot + Konten − Kreditkarten" />
        <Kennzahl titel="Depot (Positionen)" wert={geld(depotGesamt)} />
        <Kennzahl titel="Gewinn Depot (inkl. Dividenden)" wert={geld(depot.gewinn)} klasse={farbe(depot.gewinn)} />
        <Kennzahl titel="Rendite pro Jahr (XIRR)" wert={prozent(depot.xirr)} klasse={farbe(depot.xirr)} hinweis="berücksichtigt, wann gekauft wurde" />
      </div>

      {/* Ziel */}
      {ziel && z && (
        <Karte>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-semibold">
              Ziel: {geld(ziel.betrag, ziel.waehrung)} bis {new Date(`${ziel.bis}T12:00:00Z`).toLocaleDateString("de-CH", { timeZone: "UTC" })}
            </p>
            <p className="text-sm text-stone-500">noch {jahre.toFixed(1)} Jahre</p>
          </div>
          <div className="mt-2 h-3 overflow-hidden rounded-full bg-stone-200">
            <div className="h-full rounded-full bg-stone-800" style={{ width: `${(fortschritt * 100).toFixed(1)}%` }} />
          </div>
          <p className="mt-1 text-xs text-stone-500">
            {(fortschritt * 100).toFixed(1)} % erreicht ({geld(netto)} Nettovermögen)
          </p>
          <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-stone-500">Nötige Rendite ohne Sparen</dt>
              <dd className="font-medium">{prozent(z.noetigeRendite)} pro Jahr</dd>
            </div>
            <div>
              <dt className="text-stone-500">Prognose mit heutiger Rendite</dt>
              <dd className="font-medium">{depot.xirr != null ? geld(z.prognose) : "– (zu kurze Historie)"}</dd>
            </div>
            <div>
              <dt className="text-stone-500">Nötige Sparrate pro Monat</dt>
              <dd className="font-medium">{depot.xirr != null ? geld(z.sparrate) : "–"}</dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-stone-400">
            Nettovermögen aus Depot, Konten und Karten. Rendite für die Prognose: die des Depots. Rechnung, keine Beratung.
          </p>
        </Karte>
      )}

      {/* Briefing */}
      <h2 className="mb-2 mt-8 text-lg font-semibold">Briefing</h2>
      <Karte>
        {briefing ? (
          <>
            <p className="font-medium">{briefing.inhalt.titel}</p>
            <p className="mb-2 text-xs text-stone-400">{new Date(`${briefing.zeitraum}T12:00:00Z`).toLocaleDateString("de-CH", { timeZone: "UTC", dateStyle: "full" })}</p>
            <ul className="flex flex-col gap-1.5 text-sm">
              {briefing.inhalt.punkte.map((p, i) => (
                <li key={i} className="flex gap-2">
                  <span
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${p.dringlichkeit === "hoch" ? "bg-red-600" : p.dringlichkeit === "mittel" ? "bg-amber-500" : "bg-stone-300"}`}
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
      <h2 className="mb-2 mt-8 text-lg font-semibold">Konten und Karten</h2>
      <div className="flex flex-col gap-3">
        <Konten konten={konten} depotCash={depot.cash} depotCashAm={depot.cashAm} neuLaden={laden} />
      </div>

      {/* Positionen */}
      <h2 className="mb-2 mt-8 text-lg font-semibold">Positionen</h2>
      <Karte>
        {depot.positionen.length ? (
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="text-left text-xs text-stone-500">
                  <th className="px-1 pb-2 font-normal">Titel</th>
                  <th className="px-1 pb-2 text-right font-normal">Kurs</th>
                  <th className="px-1 pb-2 text-right font-normal">Wert</th>
                  <th className="px-1 pb-2 text-right font-normal">Gewinn</th>
                  <th className="px-1 pb-2 text-right font-normal">Dividenden</th>
                  <th className="px-1 pb-2 text-right font-normal">Gesamt</th>
                  <th className="px-1 pb-2 text-right font-normal">p. a.</th>
                  <th className="px-1 pb-2 text-right font-normal">Anteil</th>
                </tr>
              </thead>
              <tbody>
                {depot.positionen.map((p) => (
                  <tr key={p.papier.id} className="border-t border-stone-100 align-top">
                    <td className="px-1 py-2">
                      <a href={`#/wertpapier/${p.papier.id}`} className="font-medium underline decoration-stone-300">
                        {p.papier.emisora}
                      </a>
                      <span className="block text-xs text-stone-400">
                        {p.stueck.toLocaleString("de-CH")} Stück{p.geschaetzt ? " · teils geschätzt" : ""}
                      </span>
                    </td>
                    <td className="px-1 py-2 text-right tabular-nums">
                      {p.kurs?.toLocaleString("de-CH", { maximumFractionDigits: 4 }) ?? "–"}
                      {p.veraenderungHeute != null && (
                        <span className={`block text-xs ${farbe(p.veraenderungHeute)}`}>{prozent(p.veraenderungHeute)}</span>
                      )}
                    </td>
                    <td className="px-1 py-2 text-right tabular-nums">{geld(p.rendite.wert)}</td>
                    <td className={`px-1 py-2 text-right tabular-nums ${farbe(p.rendite.gewinn)}`}>{geld(p.rendite.gewinn)}</td>
                    <td className="px-1 py-2 text-right tabular-nums">{p.rendite.dividenden ? geld(p.rendite.dividenden) : ""}</td>
                    <td className={`px-1 py-2 text-right tabular-nums ${farbe(p.rendite.renditeProzent)}`}>{prozent(p.rendite.renditeProzent)}</td>
                    <td className={`px-1 py-2 text-right tabular-nums ${farbe(p.rendite.xirr)}`}>{prozent(p.rendite.xirr)}</td>
                    <td className="px-1 py-2 text-right tabular-nums text-stone-500">
                      {depot.wert ? `${((p.rendite.wert / depot.wert) * 100).toFixed(1)} %` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-stone-500">Noch keine Positionen. Lade unten die Dateien von HSBC hoch.</p>
        )}
        <p className="mt-3 text-xs text-stone-400">
          «Gesamt» = Gewinn inkl. Dividenden im Verhältnis zu allem, was du gekauft hast. «p. a.» = Rendite pro Jahr unter
          Berücksichtigung, wann du gekauft, verkauft und Dividenden erhalten hast (XIRR). «Teils geschätzt»: Käufe vor dem
          ersten Import sind mit dem Durchschnittspreis der Bank angesetzt; in der Position kannst du sie genau erfassen.
        </p>
      </Karte>

      {/* Limits und Aufträge */}
      <h2 className="mb-2 mt-8 text-lg font-semibold">Limits und offene Aufträge</h2>
      <Karte>
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-stone-500">Deine Limits (Meldung, wenn erreicht)</p>
        {limits.filter((l) => l.aktiv).length ? (
          <ul className="mb-3 text-sm">
            {limits
              .filter((l) => l.aktiv)
              .map((l) => (
                <li key={l.id} className="flex justify-between border-t border-stone-100 py-1">
                  <a href={`#/wertpapier/${l.wertpapier_id}`} className="underline decoration-stone-300">
                    {l.art === "kauf" ? "Kaufen" : "Verkaufen"} {l.wertpapiere?.emisora} {l.stueck ? `(${l.stueck} Stk.)` : ""} bei {l.kurs}
                  </a>
                  <span className="text-stone-500">aktuell {l.wertpapiere?.kurs ?? "–"}</span>
                </li>
              ))}
          </ul>
        ) : (
          <p className="mb-3 text-sm text-stone-500">Keine Limits. Erfassen kannst du sie in jeder Position.</p>
        )}
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-stone-500">Offene Aufträge bei HSBC</p>
        {orders.length ? (
          <ul className="text-sm">
            {orders.map((o) => (
              <li key={o.folio} className="flex justify-between border-t border-stone-100 py-1">
                <span>
                  {o.art === "kauf" ? "Kauf" : "Verkauf"} {o.stueck} {o.emisora} zu {o.kurs}
                </span>
                <span className="text-stone-500">
                  bis {o.gueltig_bis ? new Date(`${o.gueltig_bis}T12:00:00Z`).toLocaleDateString("de-CH", { timeZone: "UTC" }) : "?"} · {o.status}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-stone-500">Keine (Stand des letzten Imports).</p>
        )}
      </Karte>

      {/* Reporto */}
      <h2 className="mb-2 mt-8 text-lg font-semibold">Zinsen aus Reporto (CETES)</h2>
      <Karte>
        <p className="text-sm">
          {depot.reportoZins > 0 ? (
            <>
              {geld(depot.reportoZins, "MXN", 2)} Zins nach ISR seit {depot.reportoSeit ? new Date(`${depot.reportoSeit}T12:00:00Z`).toLocaleDateString("de-CH", { timeZone: "UTC" }) : "?"}
              {depot.reportoSatz != null && <> · durchschnittlicher Satz {depot.reportoSatz.toFixed(2)} % pro Jahr</>}
            </>
          ) : (
            <span className="text-stone-500">Noch keine Reporto-Bewegungen importiert.</span>
          )}
        </p>
      </Karte>

      {/* Import */}
      <h2 className="mb-2 mt-8 text-lg font-semibold">Dateien von HSBC hochladen</h2>
      <Karte>
        <p className="mb-2 text-sm text-stone-600">
          Im HSBC-Portal exportieren und hier hochladen (mehrere auf einmal möglich): <b>Movimientos Históricos</b> (letzte 90 Tage),{" "}
          <b>Posiciones</b> und <b>Órdenes Vigentes</b>. Doppelte Bewegungen werden erkannt. Am besten alle paar Wochen, damit die
          Historie lückenlos bleibt.
        </p>
        <input type="file" multiple accept=".xlsx" onChange={(e) => importieren(e.target.files)} className="text-sm" />
        {meldung && <p className="mt-2 text-sm text-stone-700">{meldung}</p>}
      </Karte>
      <p className="mt-6 text-xs text-stone-400">
        Der Finanz-Agent gibt Informationen und Rechnungen, keine Anlage- oder Steuerberatung, und führt nie Aufträge aus.
        {depot.positionen[0]?.papier.kurs_am && <> Kurse zuletzt {zeit(depot.positionen[0].papier.kurs_am)}.</>}
      </p>
    </Seite>
  );
}

function Kennzahl({ titel, wert, klasse = "", hinweis }: { titel: string; wert: string; klasse?: string; hinweis?: string }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-3">
      <p className="text-xs text-stone-500">{titel}</p>
      <p className={`text-lg font-semibold tabular-nums ${klasse}`}>{wert}</p>
      {hinweis && <p className="text-xs text-stone-400">{hinweis}</p>}
    </div>
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
