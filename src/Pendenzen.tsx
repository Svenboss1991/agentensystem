import { useCallback, useEffect, useState } from "react";
import { supabase, ZEITZONE } from "./lib/supabase";
import { Abschnitt, Karte, Knopf } from "./ui";

interface Pendenz {
  id: string;
  titel: string;
  gegenpartei: string | null;
  worauf: string | null;
  seit: string;
  wiedervorlage_am: string;
}

const heute = () => new Intl.DateTimeFormat("en-CA", { timeZone: ZEITZONE }).format(new Date());

function plusTage(datum: string, tage: number): string {
  const d = new Date(`${datum}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + tage);
  return d.toISOString().slice(0, 10);
}

const datumKurz = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("de-CH", { timeZone: "UTC" });

/** Dinge, auf die Sven wartet. Erinnerung gibt es erst, wenn die Wiedervorlage erreicht ist. */
export default function Pendenzen({ version }: { version: unknown }) {
  const [liste, setListe] = useState<Pendenz[]>([]);
  const [formOffen, setFormOffen] = useState(false);

  const laden = useCallback(async () => {
    const { data } = await supabase
      .from("pendenzen")
      .select("id, titel, gegenpartei, worauf, seit, wiedervorlage_am")
      .eq("status", "offen")
      .order("wiedervorlage_am");
    setListe((data ?? []) as Pendenz[]);
  }, []);

  useEffect(() => {
    laden();
  }, [laden, version]);

  async function erledigt(id: string) {
    await supabase.from("pendenzen").update({ status: "erledigt", erledigt_am: new Date().toISOString() }).eq("id", id);
    await supabase.from("tasks").update({ status: "erledigt", erledigt_am: new Date().toISOString() }).eq("pendenz_id", id).eq("status", "offen");
    setListe((l) => l.filter((p) => p.id !== id));
  }

  async function verschieben(p: Pendenz, datum: string) {
    // Neue Wiedervorlage: die alte Nachfass-Aufgabe ist damit erledigt, später wird neu erinnert.
    await supabase.from("pendenzen").update({ wiedervorlage_am: datum, erinnert_am: null }).eq("id", p.id);
    await supabase.from("tasks").update({ status: "erledigt", erledigt_am: new Date().toISOString() }).eq("pendenz_id", p.id).eq("status", "offen");
    await laden();
  }

  const h = heute();
  return (
    <Abschnitt nummer="⏳" titel="Pendenzen: ich warte auf …" anzahl={liste.length} leer="Keine offenen Pendenzen.">
      {liste.map((p) => {
        const faellig = p.wiedervorlage_am <= h;
        return (
          <Karte key={p.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-medium">{p.titel}</p>
                <p className="mt-1 text-sm text-stone-600">
                  {[p.gegenpartei, p.worauf].filter(Boolean).join(" · ")}
                </p>
                <p className="mt-2 text-xs text-stone-400">
                  seit {datumKurz(p.seit)} ·{" "}
                  <span className={faellig ? "font-medium text-red-700" : ""}>
                    Wiedervorlage {datumKurz(p.wiedervorlage_am)}
                  </span>
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Knopf onClick={() => erledigt(p.id)} primaer>
                  Erledigt
                </Knopf>
                <Knopf onClick={() => verschieben(p, plusTage(faellig ? h : p.wiedervorlage_am, 7))}>+7 Tage</Knopf>
                <input
                  type="date"
                  value={p.wiedervorlage_am}
                  min={h}
                  onChange={(e) => e.target.value && verschieben(p, e.target.value)}
                  className="rounded border border-stone-300 px-2 py-1 text-sm"
                  aria-label="Wiedervorlage"
                />
              </div>
            </div>
          </Karte>
        );
      })}
      {formOffen ? (
        <NeuePendenz
          fertig={() => {
            setFormOffen(false);
            laden();
          }}
        />
      ) : (
        <button onClick={() => setFormOffen(true)} className="self-start text-sm underline">
          + Pendenz von Hand erfassen
        </button>
      )}
    </Abschnitt>
  );
}

function NeuePendenz({ fertig }: { fertig: () => void }) {
  const [titel, setTitel] = useState("");
  const [gegenpartei, setGegenpartei] = useState("");
  const [worauf, setWorauf] = useState("");
  const [seit, setSeit] = useState(heute());
  const [wiedervorlage, setWiedervorlage] = useState(plusTage(heute(), 7));

  async function speichern(e: React.FormEvent) {
    e.preventDefault();
    await supabase.from("pendenzen").insert({
      titel,
      gegenpartei: gegenpartei || null,
      worauf: worauf || null,
      seit,
      wiedervorlage_am: wiedervorlage,
      quelle: "sven",
    });
    fertig();
  }

  const feld = "rounded border border-stone-300 px-3 py-2 text-sm";
  return (
    <Karte>
      <form onSubmit={speichern} className="grid gap-2 sm:grid-cols-2">
        <input required value={titel} onChange={(e) => setTitel(e.target.value)} placeholder="Titel, z. B. Datenauskunft Aeroméxico" className={`${feld} sm:col-span-2`} />
        <input value={gegenpartei} onChange={(e) => setGegenpartei(e.target.value)} placeholder="Von wem? (Firma/Person)" className={feld} />
        <input value={worauf} onChange={(e) => setWorauf(e.target.value)} placeholder="Was erwarte ich?" className={feld} />
        <label className="text-xs text-stone-500">
          Angefragt am
          <input type="date" value={seit} onChange={(e) => setSeit(e.target.value)} className={`${feld} mt-1 w-full`} />
        </label>
        <label className="text-xs text-stone-500">
          Wiedervorlage
          <input type="date" required value={wiedervorlage} onChange={(e) => setWiedervorlage(e.target.value)} className={`${feld} mt-1 w-full`} />
        </label>
        <div className="flex gap-2 sm:col-span-2">
          <Knopf onClick={() => {}} typ="submit" primaer>
            Speichern
          </Knopf>
          <Knopf onClick={fertig}>Abbrechen</Knopf>
        </div>
      </form>
    </Karte>
  );
}
