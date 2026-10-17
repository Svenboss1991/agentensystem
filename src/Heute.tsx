import { useCallback, useEffect, useState } from "react";
import { entwurfSenden, mailsAbrufen, MARKEN, supabase, tagesbeginn, zeit, type Marke } from "./lib/supabase";
import Pendenzen from "./Pendenzen";
import Postfaecher from "./Postfaecher";
import { Abschnitt, Karte, Knopf, Marker } from "./ui";

interface Task {
  id: string;
  titel: string;
  grund: string | null;
  quelle: string;
  faellig_am: string | null;
  erstellt_am: string;
}

interface Mail {
  id: string;
  absender: string;
  absender_name: string | null;
  betreff: string | null;
  text: string | null;
  zusammenfassung: string | null;
  kategorie: string | null;
  marke: Marke | null;
  sprache: string | null;
  empfangen_am: string | null;
  fehler: string | null;
  accounts: { adresse: string } | null;
}

interface Draft {
  id: string;
  text_original: string;
  text_deutsch: string | null;
  sprache: string | null;
  status: string;
  begruendung: string | null;
  fehler: string | null;
  messages: Mail;
}

export interface Postfach {
  id: string;
  adresse: string;
  provider: string;
  typ: "imap" | "oauth";
  marke: Marke;
  aktiv: boolean;
  sync_zuletzt: string | null;
  sync_fehler: string | null;
}

interface Zahlen {
  eingang: Record<string, number>;
  gesendet: number;
}

const MAIL_FELDER =
  "id, absender, absender_name, betreff, text, zusammenfassung, kategorie, marke, sprache, empfangen_am, fehler, accounts(adresse)";

export default function Heute() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [fuerSven, setFuerSven] = useState<Mail[]>([]);
  const [fehlerMails, setFehlerMails] = useState<Mail[]>([]);
  const [postfaecher, setPostfaecher] = useState<Postfach[]>([]);
  const [zahlen, setZahlen] = useState<Zahlen | null>(null);
  const [laden, setLaden] = useState(true);
  const [abruf, setAbruf] = useState<{ laeuft: boolean; meldung: string }>({ laeuft: false, meldung: "" });
  const [stand, setStand] = useState<Date | null>(null);

  const neuLaden = useCallback(async () => {
    const gestern = tagesbeginn(1).toISOString();
    const heute = tagesbeginn(0).toISOString();
    const [t, d, m, f, p, eingang, gesendet] = await Promise.all([
      supabase
        .from("tasks")
        .select("id, titel, grund, quelle, faellig_am, erstellt_am")
        .eq("status", "offen")
        .eq("nur_wenn_sven_handeln_muss", true)
        .order("faellig_am", { ascending: true, nullsFirst: false })
        .order("erstellt_am"),
      supabase
        .from("drafts")
        .select(`id, text_original, text_deutsch, sprache, status, begruendung, fehler, messages(${MAIL_FELDER})`)
        .in("status", ["offen", "fehler"])
        .order("erstellt_am"),
      supabase
        .from("messages")
        .select(`${MAIL_FELDER}, drafts(status)`)
        .eq("zugewiesen_an", "sven")
        .eq("status", "verarbeitet")
        .order("empfangen_am", { ascending: false }),
      supabase.from("messages").select(MAIL_FELDER).eq("status", "fehler").order("empfangen_am", { ascending: false }),
      supabase.from("accounts").select("id, adresse, provider, typ, marke, aktiv, sync_zuletzt, sync_fehler").order("adresse"),
      supabase
        .from("messages")
        .select("kategorie")
        .eq("richtung", "eingehend")
        .gte("empfangen_am", gestern)
        .lt("empfangen_am", heute),
      supabase
        .from("drafts")
        .select("id", { count: "exact", head: true })
        .eq("status", "gesendet")
        .gte("gesendet_am", gestern)
        .lt("gesendet_am", heute),
    ]);

    setTasks((t.data ?? []) as Task[]);
    setDrafts((d.data ?? []) as unknown as Draft[]);
    // Mails mit offenem Entwurf erscheinen schon unter «Entwürfe», nicht doppelt zeigen.
    setFuerSven(
      ((m.data ?? []) as unknown as (Mail & { drafts: { status: string }[] })[]).filter(
        (x) => !x.drafts.some((dr) => dr.status === "offen" || dr.status === "fehler"),
      ),
    );
    setFehlerMails((f.data ?? []) as unknown as Mail[]);
    setPostfaecher((p.data ?? []) as Postfach[]);
    const proKategorie: Record<string, number> = {};
    for (const row of eingang.data ?? []) {
      const k = (row.kategorie as string | null) ?? "noch offen";
      proKategorie[k] = (proKategorie[k] ?? 0) + 1;
    }
    setZahlen({ eingang: proKategorie, gesendet: gesendet.count ?? 0 });
    setStand(new Date());
    setLaden(false);
  }, []);

  useEffect(() => {
    neuLaden();
    const timer = setInterval(neuLaden, 60_000);
    return () => clearInterval(timer);
  }, [neuLaden]);

  async function aktualisieren() {
    setAbruf({ laeuft: true, meldung: "" });
    try {
      const ergebnis = await mailsAbrufen();
      setAbruf({ laeuft: false, meldung: `Abgerufen: ${ergebnis}` });
    } catch (err) {
      setAbruf({ laeuft: false, meldung: err instanceof Error ? err.message : String(err) });
    }
    await neuLaden();
  }

  async function taskSetzen(id: string, status: "erledigt" | "verworfen") {
    await supabase.from("tasks").update({ status, erledigt_am: new Date().toISOString() }).eq("id", id);
    setTasks((ts) => ts.filter((x) => x.id !== id));
  }

  async function mailErledigt(id: string) {
    await supabase.from("messages").update({ status: "erledigt" }).eq("id", id);
    setFuerSven((ms) => ms.filter((x) => x.id !== id));
  }

  async function erneutVersuchen(id: string) {
    await supabase.from("messages").update({ status: "neu", fehler: null }).eq("id", id);
    setFehlerMails((ms) => ms.filter((x) => x.id !== id));
  }

  const datum = new Intl.DateTimeFormat("de-CH", { timeZone: "America/Bahia_Banderas", dateStyle: "full" }).format(new Date());
  const postfachProbleme = postfaecher.filter((p) => p.aktiv && p.sync_fehler);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-8 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">Heute</h1>
          <p className="text-stone-500">{datum}</p>
        </div>
        <div className="flex flex-col items-end gap-1 text-sm">
          <div className="flex gap-4">
            <button
              onClick={aktualisieren}
              disabled={abruf.laeuft}
              className="underline disabled:no-underline disabled:opacity-60"
            >
              {abruf.laeuft ? "Holt neue Mails …" : "Aktualisieren"}
            </button>
            <button onClick={() => supabase.auth.signOut()} className="text-stone-500 underline">
              Abmelden
            </button>
          </div>
          <p className="text-xs text-stone-400">
            {abruf.meldung || (stand ? `Stand ${zeit(stand.toISOString())}` : "")}
          </p>
        </div>
      </header>

      {laden ? (
        <p className="text-stone-500">Lädt …</p>
      ) : (
        <div className="flex flex-col gap-10">
          <Abschnitt nummer="①" titel="Muss ich selbst handeln?" anzahl={tasks.length} leer="Nichts. Alles läuft.">
            {tasks.map((t) => (
              <Karte key={t.id}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="font-medium">{t.titel}</p>
                    {t.grund && <p className="mt-1 text-sm text-stone-600">{t.grund}</p>}
                    <p className="mt-2 text-xs text-stone-400">
                      {t.quelle}
                      {t.faellig_am && <span className="ml-2 font-medium text-red-700">fällig {t.faellig_am}</span>}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Knopf onClick={() => taskSetzen(t.id, "erledigt")} primaer>
                      Erledigt
                    </Knopf>
                    <Knopf onClick={() => taskSetzen(t.id, "verworfen")}>Unnötig</Knopf>
                  </div>
                </div>
              </Karte>
            ))}
          </Abschnitt>

          <Abschnitt nummer="②" titel="Entwürfe zur Freigabe" anzahl={drafts.length} leer="Keine offenen Entwürfe.">
            {drafts.map((d) => (
              <EntwurfKarte key={d.id} draft={d} fertig={() => setDrafts((ds) => ds.filter((x) => x.id !== d.id))} />
            ))}
          </Abschnitt>

          <Abschnitt nummer="③" titel="Zahlen von gestern">
            <Karte>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                {Object.entries(zahlen?.eingang ?? {}).map(([k, n]) => (
                  <div key={k}>
                    <dt className="text-stone-500">{k}</dt>
                    <dd className="text-lg font-medium">{n}</dd>
                  </div>
                ))}
                <div>
                  <dt className="text-stone-500">Antworten gesendet</dt>
                  <dd className="text-lg font-medium">{zahlen?.gesendet ?? 0}</dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-stone-400">Umsatzzahlen folgen mit dem Finanz-Agenten (Phase 3).</p>
            </Karte>
          </Abschnitt>

          <Pendenzen version={stand} />

          <Abschnitt
            nummer="✉"
            titel="Zum Lesen (privat, geschäftlich, unklar)"
            anzahl={fuerSven.length}
            leer="Nichts Neues."
          >
            {fuerSven.map((m) => (
              <Karte key={m.id}>
                <MailKopf mail={m} />
                <div className="mt-3 flex gap-2">
                  <Knopf onClick={() => mailErledigt(m.id)}>Gelesen</Knopf>
                </div>
              </Karte>
            ))}
          </Abschnitt>

          {(postfachProbleme.length > 0 || fehlerMails.length > 0) && (
            <Abschnitt nummer="⚠" titel="Störungen">
              {postfachProbleme.map((p) => (
                <Karte key={p.id}>
                  <p className="font-medium">{p.adresse}</p>
                  <p className="mt-1 text-sm text-red-700">{p.sync_fehler}</p>
                  <p className="mt-1 text-xs text-stone-400">Letzter Versuch {zeit(p.sync_zuletzt)}</p>
                </Karte>
              ))}
              {fehlerMails.map((m) => (
                <Karte key={m.id}>
                  <MailKopf mail={m} />
                  <p className="mt-2 text-sm text-red-700">{m.fehler}</p>
                  <div className="mt-3">
                    <Knopf onClick={() => erneutVersuchen(m.id)}>Erneut versuchen</Knopf>
                  </div>
                </Karte>
              ))}
            </Abschnitt>
          )}

          <Postfaecher postfaecher={postfaecher} />
        </div>
      )}
    </main>
  );
}

function EntwurfKarte({ draft, fertig }: { draft: Draft; fertig: () => void }) {
  const [text, setText] = useState(draft.text_original);
  const [status, setStatus] = useState<"" | "sendet" | string>(draft.fehler ?? "");
  const [originalOffen, setOriginalOffen] = useState(false);
  const geaendert = text !== draft.text_original;

  async function senden() {
    setStatus("sendet");
    try {
      await entwurfSenden(draft.id, text);
      fertig();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function verwerfen() {
    await supabase.from("drafts").update({ status: "verworfen" }).eq("id", draft.id);
    fertig();
  }

  const m = draft.messages;
  return (
    <Karte>
      <MailKopf mail={m} />
      <button onClick={() => setOriginalOffen((o) => !o)} className="mt-2 text-xs text-stone-500 underline">
        {originalOffen ? "Original ausblenden" : "Original anzeigen"}
      </button>
      {originalOffen && (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-stone-100 p-3 text-xs">{m.text}</pre>
      )}

      {draft.text_deutsch && (
        <div className="mt-4">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-stone-500">Übersetzung (Deutsch)</p>
          <p className="whitespace-pre-wrap rounded bg-amber-50 p-3 text-sm">{draft.text_deutsch}</p>
          {geaendert && <p className="mt-1 text-xs text-amber-700">Text wurde geändert, Übersetzung ist nicht mehr aktuell.</p>}
        </div>
      )}

      <p className="mb-1 mt-4 text-xs font-medium uppercase tracking-wide text-stone-500">
        Antwort {draft.sprache && draft.sprache !== "de" ? `(${draft.sprache.toUpperCase()})` : ""}
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={Math.min(16, text.split("\n").length + 2)}
        className="w-full rounded border border-stone-300 p-3 text-sm"
      />
      {draft.begruendung && <p className="mt-2 text-xs text-stone-500">Agent: {draft.begruendung}</p>}
      {/\[[^\]]+\]/.test(text) && (
        <p className="mt-2 text-xs font-medium text-amber-700">Enthält Platzhalter in [eckigen Klammern].</p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Knopf onClick={senden} primaer disabled={status === "sendet" || !text.trim()}>
          {status === "sendet" ? "Sendet …" : "Freigeben & senden"}
        </Knopf>
        <Knopf onClick={verwerfen} disabled={status === "sendet"}>
          Verwerfen
        </Knopf>
      </div>
      {status && status !== "sendet" && <p className="mt-2 text-sm text-red-700">{status}</p>}
    </Karte>
  );
}

function MailKopf({ mail }: { mail: Mail }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">{mail.betreff || "(ohne Betreff)"}</p>
        <p className="text-xs text-stone-400">{zeit(mail.empfangen_am)}</p>
      </div>
      <p className="text-sm text-stone-600">
        {mail.absender_name ? `${mail.absender_name} <${mail.absender}>` : mail.absender}
      </p>
      {mail.zusammenfassung && <p className="mt-2 text-sm">{mail.zusammenfassung}</p>}
      <div className="mt-2 flex flex-wrap gap-1 text-xs">
        {mail.kategorie && <Marker>{mail.kategorie}</Marker>}
        {mail.marke && mail.marke !== "keine" && <Marker>{MARKEN[mail.marke]}</Marker>}
        {mail.sprache && <Marker>{mail.sprache.toUpperCase()}</Marker>}
        {mail.accounts && <Marker>{mail.accounts.adresse}</Marker>}
      </div>
    </div>
  );
}
