import { useState } from "react";
import { geld, saldoSetzen, type Konto } from "./lib/finanzDaten";
import { supabase } from "./lib/supabase";
import { Karte, Knopf } from "./ui";

const TYPEN: Record<Konto["typ"], string> = {
  konto: "Konto",
  sparen: "Sparen",
  festgeld: "Festgeld",
  fonds: "Fonds",
  kreditkarte: "Kreditkarte",
  kaution: "Kaution/Garantie",
  sonstiges: "Sonstiges",
};

const datumKurz = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("de-CH", { timeZone: "UTC" }) : "");

/** Konten und Karten mit Saldo (direkt änderbar), Zins und Zahlungsfrist. */
export default function Konten({ konten, neuLaden }: { konten: Konto[]; neuLaden: () => void }) {
  const [neu, setNeu] = useState(false);
  const institute = [...new Set(konten.map((k) => k.institut))];
  const zinsenProJahr = konten.reduce((s, k) => s + (k.saldo > 0 && k.zinssatz ? (k.saldo * k.zinssatz) / 100 : 0), 0);
  const schulden = konten.filter((k) => k.saldo < 0).reduce((s, k) => s + k.saldo, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-2">
      {institute.map((inst) => {
        const liste = konten.filter((k) => k.institut === inst);
        const summe = liste.reduce((s, k) => s + k.saldo, 0);
        return (
          <Karte key={inst}>
            <div className="mb-2 flex items-baseline justify-between border-b border-stone-100 pb-2">
              <p className="text-base font-semibold">{inst}</p>
              <p className={`font-semibold tabular-nums ${summe < 0 ? "text-rose-700" : ""}`}>{geld(summe, "MXN", 2)}</p>
            </div>
            <ul className="divide-y divide-stone-100 text-sm">
              {liste.map((k) => (
                <KontoZeile key={k.id} k={k} neuLaden={neuLaden} />
              ))}
            </ul>
          </Karte>
        );
      })}
      </div>
      {!konten.length && (
        <Karte>
          <p className="text-sm text-stone-500">Noch keine Konten erfasst.</p>
        </Karte>
      )}
      <p className="text-xs text-stone-500">
        Erwartete Zinsen pro Jahr auf den Guthaben: {geld(zinsenProJahr)} · Kreditkarten offen: {geld(-schulden, "MXN", 2)}. Saldo
        anklicken zum Ändern. Das Barguthaben im Depot steht oben beim Aktiendepot.
      </p>
      <div>{neu ? <NeuesKonto fertig={() => (setNeu(false), neuLaden())} /> : <Knopf onClick={() => setNeu(true)}>+ Konto oder Karte</Knopf>}</div>
    </div>
  );
}

function KontoZeile({ k, neuLaden }: { k: Konto; neuLaden: () => void }) {
  const [bearbeiten, setBearbeiten] = useState(false);
  const [wert, setWert] = useState(String(Math.abs(k.saldo)));
  const karte = k.typ === "kreditkarte";
  const fristBald = k.zahlung_bis && Date.parse(k.zahlung_bis) - Date.now() < 4 * 86_400_000;

  async function speichern() {
    const n = Number(wert.replace(/[^\d.-]/g, ""));
    if (!Number.isFinite(n)) return;
    // Bei Kreditkarten wird der offene Betrag eingegeben und als Schuld (negativ) gespeichert;
    // ein Guthaben auf der Karte mit Minus eingeben.
    await saldoSetzen(k, karte ? -n : n);
    setBearbeiten(false);
    neuLaden();
  }

  return (
    <li className="flex flex-wrap items-baseline justify-between gap-2 py-2">
      <span>
        {k.name}
        {k.endziffern && <span className="ml-1 text-xs text-stone-400">…{k.endziffern}</span>}
        <span className="ml-2 text-xs text-stone-400">
          {TYPEN[k.typ]}
          {k.zinssatz ? ` · ${k.zinssatz} % Zins` : ""}
          {k.notiz ? ` · ${k.notiz}` : ""}
        </span>
        {karte && k.zahlung_bis && k.saldo < 0 && (
          <span className={`block text-xs ${fristBald ? "font-medium text-red-700" : "text-stone-500"}`}>zahlen bis {datumKurz(k.zahlung_bis)}</span>
        )}
      </span>
      {bearbeiten ? (
        <span className="flex items-center gap-1">
          <input
            autoFocus
            value={wert}
            onChange={(e) => setWert(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && speichern()}
            className="w-32 rounded border border-stone-300 px-2 py-1 text-right text-sm"
          />
          {karte && (
            <input
              type="date"
              defaultValue={k.zahlung_bis ?? ""}
              onChange={async (e) => {
                await supabase.from("konten").update({ zahlung_bis: e.target.value || null }).eq("id", k.id);
              }}
              className="rounded border border-stone-300 px-1 py-1 text-xs"
              title="Zahlungsfrist"
            />
          )}
          <Knopf onClick={speichern} primaer>
            OK
          </Knopf>
        </span>
      ) : (
        <button onClick={() => setBearbeiten(true)} className={`tabular-nums ${k.saldo < 0 ? "text-rose-700" : ""} font-medium hover:underline`} title={`Stand ${datumKurz(k.saldo_am)}`}>
          {geld(k.saldo, k.waehrung, 2)}
        </button>
      )}
    </li>
  );
}

function NeuesKonto({ fertig }: { fertig: () => void }) {
  const feld = "rounded border border-stone-300 px-2 py-1.5 text-sm";
  return (
    <Karte>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const typ = f.get("typ") as Konto["typ"];
          const betrag = Number(f.get("saldo") || 0);
          await supabase.from("konten").insert({
            name: f.get("name"),
            institut: f.get("institut"),
            typ,
            endziffern: (f.get("endziffern") as string) || null,
            saldo: typ === "kreditkarte" ? -betrag : betrag,
            zinssatz: f.get("zinssatz") ? Number(f.get("zinssatz")) : null,
            zahlung_bis: (f.get("zahlung_bis") as string) || null,
          });
          fertig();
        }}
        className="grid gap-2 sm:grid-cols-3"
      >
        <input name="institut" required placeholder="Bank, z. B. HSBC" className={feld} />
        <input name="name" required placeholder="Name, z. B. Cuenta Premier" className={feld} />
        <select name="typ" className={feld} defaultValue="konto">
          {Object.entries(TYPEN).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <input name="saldo" type="number" step="0.01" placeholder="Saldo (Kreditkarte: offener Betrag)" className={feld} />
        <input name="zinssatz" type="number" step="0.01" placeholder="Zins % pro Jahr" className={feld} />
        <input name="endziffern" maxLength={4} placeholder="letzte 4 Ziffern" className={feld} />
        <label className="text-xs text-stone-500 sm:col-span-3">
          Zahlungsfrist (nur Kreditkarte)
          <input name="zahlung_bis" type="date" className={`${feld} ml-2`} />
        </label>
        <div className="flex gap-2 sm:col-span-3">
          <Knopf onClick={() => {}} typ="submit" primaer>
            Speichern
          </Knopf>
          <Knopf onClick={fertig}>Abbrechen</Knopf>
        </div>
      </form>
    </Karte>
  );
}
