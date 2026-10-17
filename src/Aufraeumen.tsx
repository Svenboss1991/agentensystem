import { useEffect, useState } from "react";
import { funktion } from "./lib/supabase";
import { Knopf } from "./ui";

interface Vorschau {
  kategorien: { key: string; titel: string; anzahl: number }[];
  papierkorb: number;
}

interface Absender {
  adresse: string;
  name: string | null;
  anzahl: number;
  beispiele: string[];
  urteil: "muell" | "behalten" | "unsicher";
  grund: string;
}

const TEXTE = {
  gmail: {
    titel: "Gmail aufräumen",
    schutz: "Mails mit Stern oder als wichtig markiert bleiben immer unberührt. Zahlen sind Schätzungen von Gmail.",
    ordner: "den Papierkorb",
    leeren:
      "Gmail leert ihn nach 30 Tagen von selbst. Für sofort mehr Platz in Gmail links «Papierkorb» öffnen und oben «Papierkorb jetzt leeren» klicken.",
  },
  imap: {
    titel: "Postfach aufräumen",
    schutz: "Markierte Mails (Fahne/Stern) bleiben immer unberührt.",
    ordner: "den Papierkorb",
    leeren: "Für mehr Platz im Webmail deines Anbieters den Papierkorb leeren.",
  },
  hotmail: {
    titel: "Hotmail aufräumen",
    schutz: "Mails mit Fahne oder hoher Wichtigkeit bleiben immer unberührt.",
    ordner: "«Gelöschte Elemente»",
    leeren:
      "Für mehr Platz in Outlook.com mit der rechten Maustaste auf «Gelöschte Elemente» klicken und «Ordner leeren» wählen.",
  },
};

/**
 * Volles Postfach aufräumen: Claude prüft je Absender, ob es Müll ist oder noch gebraucht wird.
 * Verschoben wird nur, was Sven angehakt hat. Endgültig leert Sven selbst.
 */
export default function Aufraeumen({
  anbieter,
  accountId,
  schliessen,
}: {
  anbieter: "gmail" | "hotmail" | "imap";
  accountId: string;
  schliessen: () => void;
}) {
  const t = TEXTE[anbieter];
  const name = "aufraeumen";
  const fn = <T,>(body: Record<string, unknown>) => funktion<T>(name, { ...body, account_id: accountId });
  const [vorschau, setVorschau] = useState<Vorschau | null>(null);
  const [kategorie, setKategorie] = useState<string | null>(null);
  const [absender, setAbsender] = useState<Absender[]>([]);
  const [weitere, setWeitere] = useState(0);
  const [gewaehlt, setGewaehlt] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState("");
  const [laeuft, setLaeuft] = useState(false);

  const vorschauLaden = () =>
    fn<Vorschau>({ aktion: "vorschau" })
      .then(setVorschau)
      .catch((e) => setStatus(e.message));

  useEffect(() => {
    vorschauLaden();
  }, []);

  async function pruefen(key: string, bisher: Absender[] = []) {
    setKategorie(key);
    setLaeuft(true);
    setStatus("Claude prüft die Absender …");
    try {
      const r = await fn<{ absender: Absender[]; weitere: number }>({
        aktion: "analyse",
        kategorie: key,
        bekannt: bisher.map((a) => a.adresse),
      });
      const alle = [...bisher, ...r.absender];
      setAbsender(alle);
      setWeitere(r.weitere);
      setGewaehlt((g) => new Set([...(bisher.length ? g : []), ...r.absender.filter((a) => a.urteil === "muell").map((a) => a.adresse)]));
      setStatus("");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
    setLaeuft(false);
  }

  async function verschieben() {
    if (!kategorie) return;
    setLaeuft(true);
    let rest = [...gewaehlt];
    let gesamt = 0;
    try {
      // Grosse Mengen gehen in Portionen; weiter aufrufen, bis alle Absender erledigt sind.
      while (rest.length) {
        const r = await fn<{ verschoben: number; rest: string[] }>({ aktion: "papierkorb", kategorie, absender: rest });
        gesamt += r.verschoben;
        rest = r.rest;
        setStatus(`${gesamt.toLocaleString("de-CH")} Mails verschoben …`);
      }
      setStatus(`Fertig: ${gesamt.toLocaleString("de-CH")} Mails verschoben nach ${t.ordner}.`);
      setAbsender((a) => a.filter((x) => !gewaehlt.has(x.adresse)));
      setGewaehlt(new Set());
      await vorschauLaden();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
    setLaeuft(false);
  }

  const umschalten = (adresse: string) =>
    setGewaehlt((g) => {
      const n = new Set(g);
      if (n.has(adresse)) n.delete(adresse);
      else n.add(adresse);
      return n;
    });

  const mailsGewaehlt = absender.filter((a) => gewaehlt.has(a.adresse)).reduce((s, a) => s + a.anzahl, 0);
  const titel = vorschau?.kategorien.find((k) => k.key === kategorie)?.titel;

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
      ) : !kategorie ? (
        <>
          <p className="mb-2 text-xs text-stone-500">
            Wähle eine Kategorie. Claude prüft dann je Absender, ob es Müll ist oder noch gebraucht wird (Rechnungen,
            Buchungen, Verträge, Bank …). {t.schutz}
          </p>
          {vorschau.kategorien.map((k) => (
            <div key={k.key} className="flex items-center gap-2 py-1">
              <span className="flex-1">{k.titel}</span>
              <span className="tabular-nums text-stone-500">ca. {k.anzahl.toLocaleString("de-CH")}</span>
              <Knopf onClick={() => pruefen(k.key)} disabled={laeuft || k.anzahl === 0}>
                Prüfen
              </Knopf>
            </div>
          ))}
          {status && <p className="mt-2 text-xs text-red-700">{status}</p>}
          <p className="mt-3 text-xs text-stone-500">
            Schon in {t.ordner}: ca. {vorschau.papierkorb.toLocaleString("de-CH")} Mails. {t.leeren}
          </p>
        </>
      ) : (
        <>
          <button onClick={() => { setKategorie(null); setAbsender([]); setStatus(""); }} className="mb-2 text-xs text-stone-500 underline">
            ← andere Kategorie
          </button>
          <p className="mb-2 font-medium">{titel}</p>
          {absender.length > 0 && (
            <p className="mb-2 text-xs text-stone-500">
              Vorausgewählt ist, was Claude als Müll einstuft. «Unsicher» entscheidest du. Verschoben werden alle Mails dieser Absender in dieser
              Kategorie, nicht nur die gezählten aus der Stichprobe.
            </p>
          )}
          <div className="max-h-[28rem] divide-y divide-stone-200 overflow-auto rounded border border-stone-200 bg-white">
            {absender.map((a) => (
              <label key={a.adresse} className="flex cursor-pointer items-start gap-2 px-2 py-1.5">
                <input type="checkbox" className="mt-1" checked={gewaehlt.has(a.adresse)} disabled={laeuft} onChange={() => umschalten(a.adresse)} />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{a.name || a.adresse}</span>
                  {a.name && <span className="ml-1 text-xs text-stone-400">{a.adresse}</span>}
                  <span className="block truncate text-xs text-stone-500">{a.beispiele.join(" · ")}</span>
                </span>
                <span className="shrink-0 text-right text-xs">
                  <span
                    className={
                      a.urteil === "muell" ? "text-stone-600" : a.urteil === "behalten" ? "font-medium text-green-700" : "font-medium text-amber-700"
                    }
                  >
                    {a.urteil === "muell" ? "Müll" : a.urteil === "behalten" ? "behalten" : "unsicher"}
                  </span>
                  <span className="block text-stone-400">{a.grund}</span>
                  <span className="block tabular-nums text-stone-400">{a.anzahl}×</span>
                </span>
              </label>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Knopf onClick={verschieben} primaer disabled={laeuft || gewaehlt.size === 0}>
              {laeuft ? "Läuft …" : `${gewaehlt.size} Absender verschieben nach ${t.ordner}`}
            </Knopf>
            {weitere > 0 && (
              <Knopf onClick={() => pruefen(kategorie, absender)} disabled={laeuft}>
                Weitere {Math.min(weitere, 15)} Absender prüfen
              </Knopf>
            )}
            {status && <span className="text-xs text-stone-600">{status}</span>}
          </div>
          {gewaehlt.size > 0 && (
            <p className="mt-1 text-xs text-stone-400">In der Stichprobe: {mailsGewaehlt.toLocaleString("de-CH")} Mails dieser Absender.</p>
          )}
        </>
      )}
    </div>
  );
}
