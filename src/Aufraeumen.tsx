import { useEffect, useState } from "react";
import { funktion } from "./lib/supabase";
import { Knopf } from "./ui";

interface Vorschau {
  kategorien: { key: string; titel: string; anzahl: number }[];
  papierkorb: number;
}

const TEXTE = {
  gmail: {
    titel: "Gmail aufräumen",
    schutz: "Mails mit Stern oder als wichtig markiert bleiben immer unberührt. Zahlen sind Schätzungen von Gmail.",
    ordner: "den Papierkorb",
    leeren:
      "Gmail leert ihn nach 30 Tagen von selbst. Für sofort mehr Platz in Gmail links «Papierkorb» öffnen und oben «Papierkorb jetzt leeren» klicken.",
  },
  hotmail: {
    titel: "Hotmail aufräumen",
    schutz: "Mails mit Fahne oder hoher Wichtigkeit bleiben immer unberührt.",
    ordner: "«Gelöschte Elemente»",
    leeren:
      "Für mehr Platz in Outlook.com mit der rechten Maustaste auf «Gelöschte Elemente» klicken und «Ordner leeren» wählen.",
  },
};

/** Volles Postfach aufräumen: Vorschau, Auswahl, in den Papierkorb. Endgültig leert Sven selbst. */
export default function Aufraeumen({ anbieter, schliessen }: { anbieter: "gmail" | "hotmail"; schliessen: () => void }) {
  const t = TEXTE[anbieter];
  const fn = `${anbieter}-aufraeumen`;
  const [vorschau, setVorschau] = useState<Vorschau | null>(null);
  const [gewaehlt, setGewaehlt] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [laeuft, setLaeuft] = useState(false);

  const laden = () =>
    funktion<Vorschau>(fn, { aktion: "vorschau" })
      .then(setVorschau)
      .catch((e) => setStatus(e.message));

  useEffect(() => {
    laden();
  }, []);

  async function verschieben() {
    setLaeuft(true);
    let gesamt = 0;
    try {
      // Grosse Mengen gehen in Portionen; weiter aufrufen, bis alles verschoben ist.
      for (;;) {
        const r = await funktion<{ verschoben: number; fertig: boolean }>(fn, {
          aktion: "papierkorb",
          kategorien: gewaehlt,
        });
        gesamt += r.verschoben;
        setStatus(`${gesamt.toLocaleString("de-CH")} Mails verschoben …`);
        if (r.fertig) break;
      }
      setStatus(`Fertig: ${gesamt.toLocaleString("de-CH")} Mails verschoben nach ${t.ordner}.`);
      setGewaehlt([]);
      await laden();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
    setLaeuft(false);
  }

  return (
    <div className="mt-3 rounded border border-stone-200 bg-stone-50 p-3 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <p className="font-medium">{t.titel}</p>
        <button onClick={schliessen} className="text-xs text-stone-500 underline">
          schliessen
        </button>
      </div>
      {!vorschau ? (
        <p className="text-stone-500">{status || "Zähle Mails …"}</p>
      ) : (
        <>
          <p className="mb-2 text-xs text-stone-500">{t.schutz}</p>
          {vorschau.kategorien.map((k) => (
            <label key={k.key} className="flex items-center gap-2 py-1">
              <input
                type="checkbox"
                checked={gewaehlt.includes(k.key)}
                disabled={laeuft || k.anzahl === 0}
                onChange={(e) => setGewaehlt((g) => (e.target.checked ? [...g, k.key] : g.filter((x) => x !== k.key)))}
              />
              <span className="flex-1">{k.titel}</span>
              <span className="tabular-nums text-stone-500">ca. {k.anzahl.toLocaleString("de-CH")}</span>
            </label>
          ))}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Knopf onClick={verschieben} primaer disabled={laeuft || gewaehlt.length === 0}>
              {laeuft ? "Verschiebt …" : `Verschieben nach ${t.ordner}`}
            </Knopf>
            {status && <span className="text-xs text-stone-600">{status}</span>}
          </div>
          <p className="mt-3 text-xs text-stone-500">
            Schon in {t.ordner}: ca. {vorschau.papierkorb.toLocaleString("de-CH")} Mails. {t.leeren}
          </p>
        </>
      )}
    </div>
  );
}
