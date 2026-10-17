import { BEREICHE, type Bereich } from "./lib/supabase";

/** Leiste «Alle · Privat · Finanzen · …» zum Filtern nach Bereich. */
export default function BereichFilter({
  wert,
  setWert,
  anzahl,
}: {
  wert: Bereich | null;
  setWert: (b: Bereich | null) => void;
  anzahl?: Partial<Record<Bereich, number>>;
}) {
  const knopf = (aktiv: boolean) =>
    `rounded-full px-3 py-1 text-sm ${aktiv ? "bg-stone-900 text-white" : "border border-stone-300 bg-white text-stone-700"}`;
  return (
    <div className="flex flex-wrap gap-2">
      <button onClick={() => setWert(null)} className={knopf(wert === null)}>
        Alle
      </button>
      {BEREICHE.map((b) => (
        <button key={b.key} onClick={() => setWert(b.key)} className={knopf(wert === b.key)}>
          {b.label}
          {anzahl?.[b.key] ? <span className="ml-1 opacity-60">{anzahl[b.key]}</span> : null}
        </button>
      ))}
    </div>
  );
}
