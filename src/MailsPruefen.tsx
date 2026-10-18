import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { funktion, supabase, zeit } from "./lib/supabase";
import { Abschnitt, Karte, Knopf } from "./ui";

interface Vorlage {
  id: string;
  account_id: string;
  adresse: string;
  name: string | null;
  betreff: string | null;
  datum: string | null;
  accounts: { adresse: string } | null;
}

interface GanzeMail {
  betreff: string | null;
  datum: string;
  text: string;
}

type Urteil = "muell" | "behalten";

/** Vorgelegte Mails an den Server melden, je Postfach in Portionen zu 300. */
async function melden(mails: Vorlage[], urteil: Urteil, merken = false): Promise<void> {
  const nachPostfach = new Map<string, string[]>();
  for (const m of mails) nachPostfach.set(m.account_id, [...(nachPostfach.get(m.account_id) ?? []), m.id]);
  for (const [account_id, ids] of nachPostfach) {
    for (let i = 0; i < ids.length; i += 300) {
      await funktion("aufraeumen", { aktion: "vorlage_entscheiden", account_id, ids: ids.slice(i, i + 300), urteil, merken });
    }
  }
}

/**
 * Beim grossen Aufräumen legt der Agent jede Mail vor, die er nicht löscht (Werbung über 2 Wochen löscht er selbst).
 * Sven entscheidet je Mail oder für alle Mails eines Absenders.
 */
export default function MailsPruefen({ version }: { version: unknown }) {
  const [liste, setListe] = useState<Vorlage[]>([]);
  const [gesamt, setGesamt] = useState(0);
  const [aufgeraeumt, setAufgeraeumt] = useState(0);
  const [pruefen, setPruefen] = useState(false);
  const [laeuft, setLaeuft] = useState<string | null>(null);
  const [neu, setNeu] = useState(0);

  useEffect(() => {
    supabase
      .from("aufraeum_vorlage")
      .select("id, account_id, adresse, name, betreff, datum, accounts(adresse)", { count: "exact" })
      .eq("status", "offen")
      .order("adresse")
      .order("datum", { ascending: false })
      .limit(1000)
      .then(({ data, count }) => {
        setListe((data ?? []) as unknown as Vorlage[]);
        setGesamt(count ?? 0);
      });
    // «123 Mails in den Papierkorb …» aus dem Protokoll der letzten 7 Tage zusammenzählen.
    supabase
      .from("agent_log")
      .select("ergebnis")
      .eq("aktion", "aufgeraeumt")
      .eq("agent", "mail")
      .gte("zeit", new Date(Date.now() - 7 * 86_400_000).toISOString())
      .then(({ data }) => setAufgeraeumt((data ?? []).reduce((s, r) => s + (parseInt(r.ergebnis ?? "", 10) || 0), 0)));
  }, [version, neu]);

  // Nach Absender gruppiert, grösste Gruppen zuerst.
  const gruppen = useMemo(() => {
    const g = new Map<string, Vorlage[]>();
    for (const m of liste) g.set(`${m.account_id}|${m.adresse}`, [...(g.get(`${m.account_id}|${m.adresse}`) ?? []), m]);
    return [...g.values()].sort((a, b) => b.length - a.length);
  }, [liste]);
  // Reihenfolge fürs Durchgehen: Absender für Absender.
  const reihe = useMemo(() => gruppen.flat(), [gruppen]);

  async function gruppeEntscheiden(mails: Vorlage[], urteil: Urteil) {
    setLaeuft(mails[0].id);
    try {
      await melden(mails, urteil, urteil === "muell");
      const weg = new Set(mails.map((m) => m.id));
      setListe((l) => l.filter((m) => !weg.has(m.id)));
      setGesamt((n) => n - mails.length);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    }
    setLaeuft(null);
  }

  if (!gesamt && !aufgeraeumt) return null;
  return (
    <Abschnitt nummer="🧹" titel="Aufräumen: Mails prüfen" anzahl={gesamt}>
      {aufgeraeumt > 0 && (
        <p className="text-sm text-stone-500">
          In den letzten 7 Tagen hat der Agent {aufgeraeumt.toLocaleString("de-CH")} Mails selbständig in den Papierkorb
          verschoben (Müll älter als 2 Wochen; 30 Tage zurückholbar).
        </p>
      )}
      {pruefen && (
        <Durchgehen
          reihe={reihe}
          schliessen={() => {
            setPruefen(false);
            setNeu((n) => n + 1);
          }}
        />
      )}
      {gesamt > 0 && (
        <>
          <p className="text-sm text-stone-600">
            Bei diesen Mails ist der Agent nicht sicher, ob sie Müll sind. Er lernt aus deinen Entscheiden: Löschst du von einem
            Absender mindestens 3 Mails und behältst keine, räumt er dessen Mails künftig selbst weg.
          </p>
          <div>
            <Knopf onClick={() => setPruefen(true)} primaer>
              Durchgehen (Enter = Papierkorb, Leertaste = behalten)
            </Knopf>
          </div>
          <Karte>
            <div className="divide-y divide-stone-100">
              {gruppen.slice(0, 20).map((g) => (
                <div key={g[0].id} className="flex flex-wrap items-start gap-2 py-2 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1 text-sm">
                    <span className="font-medium">{g[0].name || g[0].adresse}</span>
                    {g[0].name && <span className="ml-1 text-xs text-stone-400">{g[0].adresse}</span>}
                    <span className="block truncate text-xs text-stone-500">
                      {g
                        .slice(0, 3)
                        .map((m) => m.betreff || "(ohne Betreff)")
                        .join(" · ")}
                    </span>
                    <span className="block text-xs text-stone-400">
                      {g[0].accounts?.adresse} · {g.length} {g.length === 1 ? "Mail" : "Mails"}
                    </span>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Knopf onClick={() => gruppeEntscheiden(g, "muell")} disabled={laeuft === g[0].id}>
                      {g.length > 1 ? `Alle ${g.length} löschen` : "Löschen"}
                    </Knopf>
                    <Knopf onClick={() => gruppeEntscheiden(g, "behalten")} disabled={laeuft === g[0].id} primaer>
                      {g.length > 1 ? "Alle behalten" : "Behalten"}
                    </Knopf>
                  </div>
                </div>
              ))}
            </div>
            {gruppen.length > 20 && <p className="mt-2 text-xs text-stone-500">… und {gruppen.length - 20} weitere Absender</p>}
            {gesamt > liste.length && (
              <p className="mt-1 text-xs text-stone-400">
                Angezeigt sind die ersten {liste.length.toLocaleString("de-CH")} von {gesamt.toLocaleString("de-CH")} Mails; der Rest
                erscheint, sobald diese erledigt sind.
              </p>
            )}
            <p className="mt-2 text-xs text-stone-400">
              «Alle löschen» merkt sich den Absender als Müll: Künftige Mails von ihm räumt der Agent selbst weg.
            </p>
          </Karte>
        </>
      )}
    </Abschnitt>
  );
}

/**
 * Mail für Mail, ganz angezeigt. Enter = Papierkorb, Leertaste = behalten,
 * Shift+Enter / Shift+Leertaste = alle restlichen Mails dieses Absenders, Esc = schliessen.
 */
function Durchgehen({ reihe, schliessen }: { reihe: Vorlage[]; schliessen: () => void }) {
  const [pos, setPos] = useState(0);
  const [inhalt, setInhalt] = useState<Record<string, GanzeMail | string>>({});
  const [offen, setOffen] = useState(0);
  const [fehler, setFehler] = useState("");
  const geladen = useRef(new Set<string>());
  const aktuell = reihe[pos];

  const laden = useCallback((m: Vorlage | undefined) => {
    if (!m || geladen.current.has(m.id)) return;
    geladen.current.add(m.id);
    funktion<{ mail: GanzeMail }>("aufraeumen", { aktion: "vorlage_lesen", account_id: m.account_id, ids: [m.id] })
      .then((r) => setInhalt((x) => ({ ...x, [m.id]: r.mail })))
      .catch((e) => setInhalt((x) => ({ ...x, [m.id]: e instanceof Error ? e.message : String(e) })));
  }, []);

  // Aktuelle und nächste zwei Mails vorladen.
  useEffect(() => {
    laden(reihe[pos]);
    laden(reihe[pos + 1]);
    laden(reihe[pos + 2]);
  }, [pos, reihe, laden]);

  const entscheiden = useCallback(
    (urteil: Urteil, ganzerAbsender: boolean) => {
      if (!aktuell) return;
      let bis = pos + 1;
      if (ganzerAbsender) {
        while (bis < reihe.length && reihe[bis].adresse === aktuell.adresse && reihe[bis].account_id === aktuell.account_id) bis++;
      }
      const mails = reihe.slice(pos, bis);
      setOffen((n) => n + 1);
      melden(mails, urteil, ganzerAbsender && urteil === "muell")
        .catch((e) => setFehler(`${aktuell.name || aktuell.adresse}: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => setOffen((n) => n - 1));
      setPos(bis);
    },
    [aktuell, pos, reihe],
  );

  useEffect(() => {
    const taste = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        entscheiden("muell", e.shiftKey);
      } else if (e.key === " ") {
        e.preventDefault();
        entscheiden("behalten", e.shiftKey);
      } else if (e.key === "Escape") {
        schliessen();
      }
    };
    window.addEventListener("keydown", taste);
    return () => window.removeEventListener("keydown", taste);
  }, [entscheiden, schliessen]);

  const mail = aktuell ? inhalt[aktuell.id] : undefined;
  const vomAbsender = aktuell ? reihe.slice(pos).filter((m) => m.adresse === aktuell.adresse && m.account_id === aktuell.account_id).length : 0;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-stone-50">
      <div className="flex items-center justify-between gap-3 border-b border-stone-200 bg-white px-4 py-3 text-sm">
        <span className="text-stone-500">
          {Math.min(pos + 1, reihe.length)} von {reihe.length}
          {offen > 0 && <span className="ml-3">verschiebt im Hintergrund … ({offen})</span>}
        </span>
        <span className="hidden text-xs text-stone-400 md:inline">
          <b>Enter</b> Papierkorb · <b>Leertaste</b> behalten · mit <b>Shift</b>: alle dieses Absenders · <b>Esc</b> schliessen
        </span>
        <button onClick={schliessen} className="underline">
          schliessen
        </button>
      </div>

      {!aktuell ? (
        <div className="m-auto text-center">
          <p className="text-lg font-medium">Alle Mails sind entschieden. 🎉</p>
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
              {aktuell.adresse} · {aktuell.accounts?.adresse}
              {vomAbsender > 1 && ` · ${vomAbsender} Mails von diesem Absender`}
            </p>
          </div>

          <div className="flex-1 overflow-auto rounded-lg border border-stone-200 bg-white p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 border-b border-stone-100 pb-2">
              <p className="font-medium">{aktuell.betreff || "(ohne Betreff)"}</p>
              {aktuell.datum && <p className="text-xs text-stone-400">{zeit(aktuell.datum)}</p>}
            </div>
            {mail === undefined ? (
              <p className="text-stone-500">Lädt Mail …</p>
            ) : typeof mail === "string" ? (
              <p className="text-red-700">{mail}</p>
            ) : (
              <pre className="whitespace-pre-wrap font-sans text-sm">{mail.text || "(kein Text)"}</pre>
            )}
          </div>

          {fehler && <p className="mt-2 text-sm text-red-700">{fehler}</p>}
          <div className="mt-3 grid grid-cols-2 gap-3">
            <button onClick={() => entscheiden("muell", false)} className="rounded-lg bg-stone-900 py-3 text-white">
              Papierkorb <span className="text-xs opacity-60">(Enter)</span>
            </button>
            <button onClick={() => entscheiden("behalten", false)} className="rounded-lg border border-stone-300 bg-white py-3">
              Behalten <span className="text-xs opacity-60">(Leertaste)</span>
            </button>
            {vomAbsender > 1 && (
              <>
                <button onClick={() => entscheiden("muell", true)} className="rounded-lg border border-stone-300 bg-white py-2 text-sm">
                  Alle {vomAbsender} dieses Absenders löschen <span className="text-xs opacity-60">(Shift+Enter)</span>
                </button>
                <button onClick={() => entscheiden("behalten", true)} className="rounded-lg border border-stone-300 bg-white py-2 text-sm">
                  Alle {vomAbsender} behalten <span className="text-xs opacity-60">(Shift+Leertaste)</span>
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
