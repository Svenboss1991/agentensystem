import { useCallback, useEffect, useState } from "react";
import BereichFilter from "./BereichFilter";
import { BEREICHE, bereichLabel, supabase, ZEITZONE, type Bereich } from "./lib/supabase";
import { Seite } from "./Seite";
import { Karte, Knopf } from "./ui";

interface Abo {
  id: string;
  anbieter: string;
  produkt: string | null;
  bereich: Bereich;
  betrag: number | null;
  waehrung: string | null;
  intervall: string | null;
  status: "test" | "aktiv" | "gekuendigt" | "beendet";
  beginn: string | null;
  testphase_bis: string | null;
  naechste_zahlung: string | null;
  laufzeit_bis: string | null;
  kuendigungsfrist: string | null;
  kuendbar_bis: string | null;
  zahlungsmittel: string | null;
  konto: string | null;
  erinnern_am: string | null;
  notiz: string | null;
  quelle_message_id: string | null;
}

const INTERVALLE: Record<string, { label: string; proMonat: number }> = {
  woechentlich: { label: "pro Woche", proMonat: 52 / 12 },
  monatlich: { label: "pro Monat", proMonat: 1 },
  quartalsweise: { label: "pro Quartal", proMonat: 1 / 3 },
  halbjaehrlich: { label: "pro Halbjahr", proMonat: 1 / 6 },
  jaehrlich: { label: "pro Jahr", proMonat: 1 / 12 },
  einmalig: { label: "einmalig", proMonat: 0 },
};

const STATUS: Record<Abo["status"], string> = { test: "Testphase", aktiv: "aktiv", gekuendigt: "gekündigt", beendet: "beendet" };

const datumKurz = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("de-CH", { timeZone: "UTC" }) : "");
const geld = (n: number, w: string) => `${w} ${n.toLocaleString("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const heute = () => new Intl.DateTimeFormat("en-CA", { timeZone: ZEITZONE }).format(new Date());

const FELDER =
  "id, anbieter, produkt, bereich, betrag, waehrung, intervall, status, beginn, testphase_bis, naechste_zahlung, laufzeit_bis, kuendigungsfrist, kuendbar_bis, zahlungsmittel, konto, erinnern_am, notiz, quelle_message_id";

export function AbosSeite() {
  const [abos, setAbos] = useState<Abo[]>([]);
  const [bereich, setBereich] = useState<Bereich | null>(null);
  const [alle, setAlle] = useState(false);
  const [offen, setOffen] = useState<string | null>(null);

  const laden = useCallback(async () => {
    const { data } = await supabase.from("abos").select(FELDER).order("anbieter");
    setAbos((data ?? []) as Abo[]);
  }, []);

  useEffect(() => {
    laden();
  }, [laden]);

  async function neu() {
    const { data } = await supabase
      .from("abos")
      .insert({ anbieter: "Neues Abo", bereich: bereich ?? "privat", intervall: "monatlich", waehrung: "CHF" })
      .select("id")
      .single();
    await laden();
    if (data) setOffen(data.id);
  }

  const sichtbar = abos
    .filter((a) => !bereich || a.bereich === bereich)
    .filter((a) => alle || a.status === "aktiv" || a.status === "test");

  // Laufende Kosten pro Monat, je Währung (gekündigte Abos laufen bis zum Ende mit).
  const proMonat = new Map<string, number>();
  for (const a of sichtbar) {
    if (a.betrag == null || !a.intervall || a.status === "beendet") continue;
    const w = a.waehrung ?? "CHF";
    proMonat.set(w, (proMonat.get(w) ?? 0) + a.betrag * (INTERVALLE[a.intervall]?.proMonat ?? 0));
  }
  const h = heute();

  return (
    <Seite titel="Abos">
      <div className="mb-3">
        <BereichFilter wert={bereich} setWert={setBereich} />
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Karte>
          <p className="text-xs text-stone-500">Laufende Kosten pro Monat</p>
          <p className="text-xl font-semibold tabular-nums">
            {proMonat.size ? [...proMonat].map(([w, n]) => geld(n, w)).join(" · ") : "–"}
          </p>
          <p className="text-xs text-stone-400">
            pro Jahr: {proMonat.size ? [...proMonat].map(([w, n]) => geld(n * 12, w)).join(" · ") : "–"}
          </p>
        </Karte>
        <label className="flex items-center gap-1 text-sm text-stone-600">
          <input type="checkbox" checked={alle} onChange={(e) => setAlle(e.target.checked)} />
          auch gekündigte und beendete
        </label>
        <Knopf onClick={neu} primaer>
          + Abo
        </Knopf>
      </div>

      <Karte>
        {sichtbar.length ? (
          <div className="divide-y divide-stone-100">
            {sichtbar.map((a) => {
              const frist = a.status === "test" ? a.testphase_bis : a.kuendbar_bis;
              const bald = frist && frist <= h ? "text-red-700 font-medium" : "text-stone-500";
              return (
                <div key={a.id} className="py-2 first:pt-0 last:pb-0">
                  <button onClick={() => setOffen(offen === a.id ? null : a.id)} className="flex w-full flex-wrap items-baseline justify-between gap-2 text-left">
                    <span>
                      <span className="font-medium">{a.anbieter}</span>
                      {a.produkt && <span className="ml-2 text-sm text-stone-500">{a.produkt}</span>}
                      <span className="ml-2 rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600">{STATUS[a.status]}</span>
                      {!bereich && <span className="ml-2 text-xs text-stone-400">{bereichLabel(a.bereich)}</span>}
                    </span>
                    <span className="text-right text-sm">
                      <span className="tabular-nums">
                        {a.betrag != null ? `${geld(a.betrag, a.waehrung ?? "CHF")} ${INTERVALLE[a.intervall ?? ""]?.label ?? ""}` : "Betrag?"}
                      </span>
                      <span className={`block text-xs ${bald}`}>
                        {a.status === "test" && a.testphase_bis
                          ? `Testphase bis ${datumKurz(a.testphase_bis)}`
                          : a.kuendbar_bis
                            ? `kündbar bis ${datumKurz(a.kuendbar_bis)}`
                            : a.naechste_zahlung
                              ? `nächste Zahlung ${datumKurz(a.naechste_zahlung)}`
                              : ""}
                      </span>
                    </span>
                  </button>
                  {offen === a.id && <AboBearbeiten abo={a} fertig={laden} />}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-stone-500">
            Noch keine Abos. Der Agent erfasst sie automatisch, sobald eine Mail zu einem Abo kommt (Abschluss, Testphase,
            Verlängerung, Preisänderung, Kündigung).
          </p>
        )}
      </Karte>
    </Seite>
  );
}

function AboBearbeiten({ abo, fertig }: { abo: Abo; fertig: () => void }) {
  const [w, setW] = useState<Abo>(abo);
  const [status, setStatus] = useState("");
  const setze = <K extends keyof Abo>(k: K, v: Abo[K]) => setW((x) => ({ ...x, [k]: v }));
  const feld = "rounded border border-stone-300 px-2 py-1.5 text-sm text-stone-900 w-full mt-1";

  async function speichern(e: React.FormEvent) {
    e.preventDefault();
    const { id, ...rest } = w;
    // Neue Erinnerung, wenn das Datum geändert wurde.
    const erinnerung = rest.erinnern_am !== abo.erinnern_am ? { erinnert_am: null } : {};
    const { error } = await supabase
      .from("abos")
      .update({ ...rest, ...erinnerung, aktualisiert_am: new Date().toISOString() })
      .eq("id", id);
    setStatus(error ? error.message : "gespeichert");
    if (!error) fertig();
  }

  async function loeschen() {
    if (!window.confirm(`Abo «${abo.anbieter}» aus der Liste löschen?`)) return;
    await supabase.from("abos").delete().eq("id", abo.id);
    fertig();
  }

  const text = (k: keyof Abo, label: string, breit = false) => (
    <label className={`text-xs text-stone-500 ${breit ? "sm:col-span-2" : ""}`}>
      {label}
      <input value={(w[k] as string | null) ?? ""} onChange={(e) => setze(k, (e.target.value || null) as never)} className={feld} />
    </label>
  );
  const datum = (k: keyof Abo, label: string) => (
    <label className="text-xs text-stone-500">
      {label}
      <input type="date" value={(w[k] as string | null) ?? ""} onChange={(e) => setze(k, (e.target.value || null) as never)} className={feld} />
    </label>
  );

  return (
    <form onSubmit={speichern} className="mt-3 grid gap-2 rounded bg-stone-50 p-3 sm:grid-cols-2">
      {text("anbieter", "Anbieter")}
      {text("produkt", "Produkt")}
      <label className="text-xs text-stone-500">
        Betrag
        <input
          type="number"
          step="0.01"
          value={w.betrag ?? ""}
          onChange={(e) => setze("betrag", e.target.value === "" ? null : Number(e.target.value))}
          className={feld}
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        {text("waehrung", "Währung")}
        <label className="text-xs text-stone-500">
          Intervall
          <select value={w.intervall ?? ""} onChange={(e) => setze("intervall", e.target.value || null)} className={feld}>
            <option value="">?</option>
            {Object.entries(INTERVALLE).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="text-xs text-stone-500">
        Status
        <select value={w.status} onChange={(e) => setze("status", e.target.value as Abo["status"])} className={feld}>
          {Object.entries(STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-stone-500">
        Bereich
        <select value={w.bereich} onChange={(e) => setze("bereich", e.target.value as Bereich)} className={feld}>
          {BEREICHE.map((b) => (
            <option key={b.key} value={b.key}>
              {b.label}
            </option>
          ))}
        </select>
      </label>
      {datum("beginn", "Beginn")}
      {datum("testphase_bis", "Testphase bis")}
      {datum("naechste_zahlung", "Nächste Zahlung")}
      {datum("laufzeit_bis", "Mindestlaufzeit bis")}
      {text("kuendigungsfrist", "Kündigungsfrist")}
      {datum("kuendbar_bis", "Kündbar bis")}
      {text("zahlungsmittel", "Zahlungsmittel")}
      {text("konto", "Konto / Login")}
      {datum("erinnern_am", "Erinnern am")}
      {text("notiz", "Notiz", true)}
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
        <Knopf onClick={() => {}} typ="submit" primaer>
          Speichern
        </Knopf>
        <button type="button" onClick={loeschen} className="text-xs text-stone-400 underline">
          löschen
        </button>
        {status && <span className="text-xs text-stone-600">{status}</span>}
      </div>
    </form>
  );
}
