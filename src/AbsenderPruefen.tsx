import { useCallback, useEffect, useRef, useState } from "react";
import { funktion, zeit } from "./lib/supabase";

export interface Unsicher {
  id: string;
  account_id: string;
  kategorie: string;
  adresse: string;
  name: string | null;
  beispiele: string[];
  anzahl: number;
  grund: string | null;
  accounts: { adresse: string } | null;
}

interface BeispielMail {
  betreff: string | null;
  datum: string;
  text: string;
}

/**
 * Unsichere Absender einzeln durchgehen, mit ganzer Mail.
 * Enter = Papierkorb, Leertaste = behalten, ← → = andere Mail dieses Absenders, Esc = schliessen.
 */
export default function AbsenderPruefen({
  liste,
  entschieden,
  schliessen,
}: {
  liste: Unsicher[];
  entschieden: (id: string) => void;
  schliessen: () => void;
}) {
  const [pos, setPos] = useState(0);
  const [mails, setMails] = useState<Record<string, BeispielMail[] | string>>({});
  const [mailIndex, setMailIndex] = useState(0);
  const [offen, setOffen] = useState(0); // Entscheide, die im Hintergrund noch verschieben
  const [fehler, setFehler] = useState("");
  const geladen = useRef(new Set<string>());

  const aktuell = liste[pos];

  const laden = useCallback((u: Unsicher | undefined) => {
    if (!u || geladen.current.has(u.id)) return;
    geladen.current.add(u.id);
    funktion<{ mails: BeispielMail[] }>("aufraeumen", {
      aktion: "beispiele",
      account_id: u.account_id,
      kategorie: u.kategorie,
      absender: [u.adresse],
    })
      .then((r) => setMails((m) => ({ ...m, [u.id]: r.mails })))
      .catch((e) => setMails((m) => ({ ...m, [u.id]: e instanceof Error ? e.message : String(e) })));
  }, []);

  // Aktuellen und nächsten Absender vorladen, damit es ohne Warten weitergeht.
  useEffect(() => {
    laden(liste[pos]);
    laden(liste[pos + 1]);
  }, [pos, liste, laden]);

  const entscheiden = useCallback(
    (urteil: "muell" | "behalten") => {
      const u = liste[pos];
      if (!u) return;
      setOffen((n) => n + 1);
      // Im Hintergrund: bei «Müll» werden alle Mails des Absenders verschoben, in Portionen.
      (async () => {
        try {
          let rest = [u.adresse];
          do {
            const r = await funktion<{ rest: string[] }>("aufraeumen", {
              aktion: "entscheiden",
              account_id: u.account_id,
              kategorie: u.kategorie,
              absender: rest,
              urteil,
            });
            rest = r.rest;
          } while (rest.length);
          entschieden(u.id);
        } catch (e) {
          setFehler(`${u.name || u.adresse}: ${e instanceof Error ? e.message : String(e)}`);
        }
        setOffen((n) => n - 1);
      })();
      setMailIndex(0);
      setPos((p) => p + 1);
    },
    [liste, pos, entschieden],
  );

  useEffect(() => {
    const taste = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        entscheiden("muell");
      } else if (e.key === " ") {
        e.preventDefault();
        entscheiden("behalten");
      } else if (e.key === "ArrowRight") {
        setMailIndex((i) => i + 1);
      } else if (e.key === "ArrowLeft") {
        setMailIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "Escape") {
        schliessen();
      }
    };
    window.addEventListener("keydown", taste);
    return () => window.removeEventListener("keydown", taste);
  }, [entscheiden, schliessen]);

  const beispiele = aktuell ? mails[aktuell.id] : undefined;
  const liste3 = Array.isArray(beispiele) ? beispiele : [];
  const mail = liste3[Math.min(mailIndex, Math.max(0, liste3.length - 1))];

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-stone-50">
      <div className="flex items-center justify-between gap-3 border-b border-stone-200 bg-white px-4 py-3 text-sm">
        <span className="text-stone-500">
          {Math.min(pos + 1, liste.length)} von {liste.length}
          {offen > 0 && <span className="ml-3">verschiebt im Hintergrund … ({offen})</span>}
        </span>
        <span className="hidden text-xs text-stone-400 sm:inline">
          <b>Enter</b> Papierkorb · <b>Leertaste</b> behalten · <b>← →</b> andere Mail · <b>Esc</b> schliessen
        </span>
        <button onClick={schliessen} className="underline">
          schliessen
        </button>
      </div>

      {!aktuell ? (
        <div className="m-auto text-center">
          <p className="text-lg font-medium">Alle unsicheren Absender sind entschieden. 🎉</p>
          {offen > 0 && <p className="mt-2 text-sm text-stone-500">Es wird noch verschoben, die Seite kann offen bleiben.</p>}
          <button onClick={schliessen} className="mt-4 rounded bg-stone-900 px-4 py-2 text-white">
            Zurück
          </button>
        </div>
      ) : (
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-hidden px-4 py-4">
          <div className="mb-3">
            <p className="text-lg font-semibold">{aktuell.name || aktuell.adresse}</p>
            <p className="text-sm text-stone-500">
              {aktuell.adresse} · {aktuell.accounts?.adresse} · {aktuell.anzahl}× in der Stichprobe
              {aktuell.grund ? ` · Agent: ${aktuell.grund}` : ""}
            </p>
          </div>

          <div className="flex-1 overflow-auto rounded-lg border border-stone-200 bg-white p-4">
            {beispiele === undefined ? (
              <p className="text-stone-500">Lädt Mail …</p>
            ) : typeof beispiele === "string" ? (
              <p className="text-red-700">{beispiele}</p>
            ) : !mail ? (
              <p className="text-stone-500">Keine Mail mehr gefunden (vielleicht schon verschoben).</p>
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 border-b border-stone-100 pb-2">
                  <p className="font-medium">{mail.betreff || "(ohne Betreff)"}</p>
                  <p className="text-xs text-stone-400">
                    {zeit(mail.datum)}
                    {liste3.length > 1 && ` · Mail ${Math.min(mailIndex, liste3.length - 1) + 1} von ${liste3.length}`}
                  </p>
                </div>
                <pre className="whitespace-pre-wrap font-sans text-sm">{mail.text || "(kein Text)"}</pre>
              </>
            )}
          </div>

          {fehler && <p className="mt-2 text-sm text-red-700">{fehler}</p>}
          <div className="mt-3 grid grid-cols-2 gap-3">
            <button onClick={() => entscheiden("muell")} className="rounded-lg bg-stone-900 py-3 text-white">
              Papierkorb <span className="text-xs opacity-60">(Enter)</span>
            </button>
            <button onClick={() => entscheiden("behalten")} className="rounded-lg border border-stone-300 bg-white py-3">
              Behalten <span className="text-xs opacity-60">(Leertaste)</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
