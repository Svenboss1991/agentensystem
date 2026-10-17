import { useCallback, useEffect, useState } from "react";
import { MAIL_FELDER, MailKopf, type Mail } from "./Mail";
import BereichFilter from "./BereichFilter";
import { BEREICHE, bereichLabel, supabase, zeit, ZEITZONE, type Bereich } from "./lib/supabase";
import { Abschnitt, Karte, Knopf, Marker } from "./ui";

interface Akte {
  id: string;
  nummer: string;
  titel: string;
  gegenpartei: string | null;
  gegenpartei_adresse: string | null;
  worauf: string | null;
  status: "offen" | "erledigt" | "verworfen";
  bereich: Bereich;
  am_zug: "gegenseite" | "sven";
  seit: string;
  wiedervorlage_am: string | null;
  zuletzt_aktiv: string;
  notiz: string | null;
}

interface Eintrag {
  id: string;
  typ: "notiz" | "ereignis";
  text: string;
  von: string;
  erstellt_am: string;
}

const AKTE_FELDER =
  "id, nummer, titel, gegenpartei, gegenpartei_adresse, worauf, status, bereich, am_zug, seit, wiedervorlage_am, zuletzt_aktiv, notiz";

const heute = () => new Intl.DateTimeFormat("en-CA", { timeZone: ZEITZONE }).format(new Date());

function plusTage(datum: string, tage: number): string {
  const d = new Date(`${datum}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + tage);
  return d.toISOString().slice(0, 10);
}

const datumKurz = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("de-CH", { timeZone: "UTC" });

export const zurAkte = (id: string) => (window.location.hash = `#/akte/${id}`);

export function AkteLink({ id, nummer }: { id: string; nummer: string }) {
  return (
    <a href={`#/akte/${id}`} className="mr-2 font-medium text-stone-700 underline">
      {nummer}
    </a>
  );
}

function StatusMarker({ akte }: { akte: Akte }) {
  if (akte.status !== "offen") return <Marker>{akte.status}</Marker>;
  const faellig = akte.am_zug === "gegenseite" && akte.wiedervorlage_am && akte.wiedervorlage_am <= heute();
  if (akte.am_zug === "sven") return <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">ich bin dran</span>;
  return (
    <span className={`rounded px-1.5 py-0.5 ${faellig ? "bg-red-100 text-red-800" : "bg-stone-100 text-stone-600"}`}>
      ich warte{akte.wiedervorlage_am ? ` · WV ${datumKurz(akte.wiedervorlage_am)}` : ""}
    </span>
  );
}

function AkteZeile({ akte }: { akte: Akte }) {
  return (
    <button
      onClick={() => zurAkte(akte.id)}
      className="flex w-full flex-wrap items-baseline justify-between gap-2 py-2 text-left first:pt-0 last:pb-0 hover:bg-stone-50"
    >
      <span>
        <span className="mr-2 text-xs text-stone-400">{akte.nummer}</span>
        <span className="font-medium">{akte.titel}</span>
        {akte.gegenpartei && <span className="ml-2 text-sm text-stone-500">{akte.gegenpartei}</span>}
      </span>
      <span className="ml-auto mr-2 text-xs text-stone-400">{bereichLabel(akte.bereich)}</span>
      <span className="text-xs">
        <StatusMarker akte={akte} />
      </span>
    </button>
  );
}

// ─── Auf «Heute»: offene Akten ───────────────────────────────────────────────

export function AktenUebersicht({ version, bereich }: { version: unknown; bereich: Bereich | null }) {
  const [akten, setAkten] = useState<Akte[]>([]);

  useEffect(() => {
    supabase
      .from("akten")
      .select(AKTE_FELDER)
      .eq("status", "offen")
      .order("am_zug", { ascending: false }) // «sven» vor «gegenseite»
      .order("wiedervorlage_am", { ascending: true, nullsFirst: false })
      .then(({ data }) => setAkten((data ?? []) as Akte[]));
  }, [version]);

  const sichtbar = bereich ? akten.filter((a) => a.bereich === bereich) : akten;
  const gruppen = BEREICHE.map((b) => ({ ...b, akten: sichtbar.filter((a) => a.bereich === b.key) })).filter(
    (g) => g.akten.length,
  );

  return (
    <Abschnitt nummer="📁" titel="Offene Akten" anzahl={sichtbar.length} leer="Keine offenen Akten.">
      {gruppen.map((g) => (
        <Karte key={g.key}>
          {!bereich && <p className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-400">{g.label}</p>}
          <div className="divide-y divide-stone-100">
            {g.akten.map((a) => (
              <AkteZeile key={a.id} akte={a} />
            ))}
          </div>
        </Karte>
      ))}
      <a href="#/akten" className="self-start text-sm underline">
        Alle Akten anzeigen
      </a>
    </Abschnitt>
  );
}

// ─── Mail in Akte ablegen ────────────────────────────────────────────────────

export function InAkteAblegen({ mail, bereich, fertig }: { mail: Mail; bereich: Bereich; fertig: () => void }) {
  const [offen, setOffen] = useState(false);
  const [akten, setAkten] = useState<Akte[]>([]);

  useEffect(() => {
    if (!offen) return;
    supabase
      .from("akten")
      .select(AKTE_FELDER)
      .eq("status", "offen")
      .order("zuletzt_aktiv", { ascending: false })
      .then(({ data }) => setAkten((data ?? []) as Akte[]));
  }, [offen]);

  async function ablegen(akteId: string) {
    await supabase.from("messages").update({ akte_id: akteId }).eq("id", mail.id);
    await supabase.from("akten").update({ zuletzt_aktiv: new Date().toISOString() }).eq("id", akteId);
    setOffen(false);
    fertig();
  }

  async function neueAkte() {
    const { data } = await supabase
      .from("akten")
      .insert({
        titel: mail.betreff || "Ohne Titel",
        gegenpartei: mail.absender_name ?? mail.absender,
        gegenpartei_adresse: mail.absender,
        am_zug: "sven",
        bereich,
        seit: mail.empfangen_am?.slice(0, 10) ?? heute(),
        message_id: mail.id,
        quelle: "sven",
      })
      .select("id")
      .single();
    if (data) {
      await ablegen(data.id);
      zurAkte(data.id);
    }
  }

  if (!offen) return <Knopf onClick={() => setOffen(true)}>In Akte ablegen</Knopf>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        defaultValue=""
        onChange={(e) => e.target.value && ablegen(e.target.value)}
        className="rounded border border-stone-300 px-2 py-1.5 text-sm"
      >
        <option value="" disabled>
          Akte wählen …
        </option>
        {akten.map((a) => (
          <option key={a.id} value={a.id}>
            {a.nummer} {a.titel}
          </option>
        ))}
      </select>
      <Knopf onClick={neueAkte}>Neue Akte</Knopf>
      <Knopf onClick={() => setOffen(false)}>Abbrechen</Knopf>
    </div>
  );
}

// ─── Seite: alle Akten ───────────────────────────────────────────────────────

export function AktenSeite() {
  const [akten, setAkten] = useState<Akte[]>([]);
  const [filter, setFilter] = useState<"offen" | "erledigt" | "alle">("offen");
  const [suche, setSuche] = useState("");
  const [neu, setNeu] = useState(false);
  const [bereich, setBereich] = useState<Bereich | null>(null);

  useEffect(() => {
    let q = supabase.from("akten").select(AKTE_FELDER).order("zuletzt_aktiv", { ascending: false });
    if (filter !== "alle") q = q.eq("status", filter);
    q.then(({ data }) => setAkten((data ?? []) as Akte[]));
  }, [filter]);

  const s = suche.trim().toLowerCase();
  const anzahl: Partial<Record<Bereich, number>> = {};
  for (const a of akten) anzahl[a.bereich] = (anzahl[a.bereich] ?? 0) + 1;
  const sichtbar = akten
    .filter((a) => !bereich || a.bereich === bereich)
    .filter((a) => !s || [a.nummer, a.titel, a.gegenpartei, a.worauf].some((x) => x?.toLowerCase().includes(s)));

  return (
    <Seite titel="Akten">
      <div className="mb-3">
        <BereichFilter wert={bereich} setWert={setBereich} anzahl={anzahl} />
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(["offen", "erledigt", "alle"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded px-3 py-1.5 text-sm ${filter === f ? "bg-stone-900 text-white" : "border border-stone-300 bg-white"}`}
          >
            {f}
          </button>
        ))}
        <input
          value={suche}
          onChange={(e) => setSuche(e.target.value)}
          placeholder="Suchen (Nummer, Titel, Gegenpartei)"
          className="min-w-0 flex-1 rounded border border-stone-300 px-3 py-1.5 text-sm"
        />
        <Knopf onClick={() => setNeu(true)} primaer>
          + Neue Akte
        </Knopf>
      </div>
      {neu && <NeueAkte bereich={bereich ?? "privat"} abbrechen={() => setNeu(false)} />}
      <Karte>
        {sichtbar.length ? (
          <div className="divide-y divide-stone-100">
            {sichtbar.map((a) => (
              <AkteZeile key={a.id} akte={a} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-stone-500">Keine Akten.</p>
        )}
      </Karte>
    </Seite>
  );
}

function NeueAkte({ bereich: start, abbrechen }: { bereich: Bereich; abbrechen: () => void }) {
  const [titel, setTitel] = useState("");
  const [bereich, setBereich] = useState<Bereich>(start);
  const [gegenpartei, setGegenpartei] = useState("");
  const [worauf, setWorauf] = useState("");
  const [seit, setSeit] = useState(heute());
  const [wiedervorlage, setWiedervorlage] = useState(plusTage(heute(), 7));

  async function speichern(e: React.FormEvent) {
    e.preventDefault();
    const { data } = await supabase
      .from("akten")
      .insert({
        titel,
        gegenpartei: gegenpartei || null,
        worauf: worauf || null,
        seit,
        wiedervorlage_am: wiedervorlage || null,
        am_zug: "gegenseite",
        bereich,
        quelle: "sven",
      })
      .select("id")
      .single();
    if (data) zurAkte(data.id);
  }

  const feld = "rounded border border-stone-300 px-3 py-2 text-sm";
  return (
    <div className="mb-4">
      <Karte>
        <form onSubmit={speichern} className="grid gap-2 sm:grid-cols-2">
          <input required value={titel} onChange={(e) => setTitel(e.target.value)} placeholder="Titel, z. B. Datenauskunft Aeroméxico" className={`${feld} sm:col-span-2`} />
          <BereichWahl wert={bereich} setWert={setBereich} />
          <input value={gegenpartei} onChange={(e) => setGegenpartei(e.target.value)} placeholder="Gegenpartei (Firma/Person)" className={feld} />
          <input value={worauf} onChange={(e) => setWorauf(e.target.value)} placeholder="Worum geht es / was erwarte ich?" className={`${feld} sm:col-span-2`} />
          <label className="text-xs text-stone-500">
            Seit
            <input type="date" value={seit} onChange={(e) => setSeit(e.target.value)} className={`${feld} mt-1 w-full`} />
          </label>
          <label className="text-xs text-stone-500">
            Wiedervorlage
            <input type="date" value={wiedervorlage} onChange={(e) => setWiedervorlage(e.target.value)} className={`${feld} mt-1 w-full`} />
          </label>
          <div className="flex gap-2 sm:col-span-2">
            <Knopf onClick={() => {}} typ="submit" primaer>
              Akte eröffnen
            </Knopf>
            <Knopf onClick={abbrechen}>Abbrechen</Knopf>
          </div>
        </form>
      </Karte>
    </div>
  );
}

// ─── Seite: eine Akte mit Verlauf ────────────────────────────────────────────

type Verlauf = { zeit: string; mail?: Mail; eintrag?: Eintrag };

export function AkteSeite({ id }: { id: string }) {
  const [akte, setAkte] = useState<Akte | null>(null);
  const [verlauf, setVerlauf] = useState<Verlauf[]>([]);
  const [notiz, setNotiz] = useState("");
  const [andere, setAndere] = useState<Akte[]>([]);

  useEffect(() => {
    supabase
      .from("akten")
      .select(AKTE_FELDER)
      .eq("status", "offen")
      .neq("id", id)
      .order("zuletzt_aktiv", { ascending: false })
      .then(({ data }) => setAndere((data ?? []) as Akte[]));
  }, [id]);

  const laden = useCallback(async () => {
    const [a, m, e] = await Promise.all([
      supabase.from("akten").select(AKTE_FELDER).eq("id", id).single(),
      supabase.from("messages").select(MAIL_FELDER).eq("akte_id", id),
      supabase.from("akte_eintraege").select("id, typ, text, von, erstellt_am").eq("akte_id", id),
    ]);
    setAkte(a.data as Akte | null);
    const v: Verlauf[] = [
      ...((m.data ?? []) as unknown as Mail[]).map((mail) => ({ zeit: mail.empfangen_am ?? "", mail })),
      ...((e.data ?? []) as Eintrag[]).map((eintrag) => ({ zeit: eintrag.erstellt_am, eintrag })),
    ];
    v.sort((x, y) => y.zeit.localeCompare(x.zeit));
    setVerlauf(v);
  }, [id]);

  useEffect(() => {
    laden();
  }, [laden]);

  async function aendern(felder: Partial<Akte> & Record<string, unknown>, ereignis?: string) {
    await supabase.from("akten").update({ ...felder, zuletzt_aktiv: new Date().toISOString() }).eq("id", id);
    // Wer die Akte selbst weiterschiebt, hat die offenen Aufgaben dazu erledigt.
    if (felder.status === "erledigt") {
      await supabase.from("messages").update({ status: "erledigt" }).eq("akte_id", id).eq("status", "verarbeitet");
    }
    if (felder.status === "erledigt" || felder.wiedervorlage_am || felder.am_zug === "gegenseite") {
      await supabase.from("tasks").update({ status: "erledigt", erledigt_am: new Date().toISOString() }).eq("akte_id", id).eq("status", "offen");
    }
    if (ereignis) await supabase.from("akte_eintraege").insert({ akte_id: id, typ: "ereignis", text: ereignis });
    await laden();
  }

  async function notizSpeichern(e: React.FormEvent) {
    e.preventDefault();
    if (!notiz.trim()) return;
    await supabase.from("akte_eintraege").insert({ akte_id: id, typ: "notiz", text: notiz.trim() });
    await supabase.from("akten").update({ zuletzt_aktiv: new Date().toISOString() }).eq("id", id);
    setNotiz("");
    await laden();
  }

  async function zusammenfuehren(zielId: string) {
    const ziel = andere.find((a) => a.id === zielId);
    if (!ziel || !akte) return;
    if (!window.confirm(`${akte.nummer} in ${ziel.nummer} «${ziel.titel}» zusammenführen? Alle Mails und Notizen wandern dorthin.`)) return;
    const { error } = await supabase.rpc("akten_zusammenfuehren", { quell_akte: id, ziel_akte: zielId });
    if (error) return window.alert(error.message);
    zurAkte(zielId);
  }

  async function mailUmbuchen(mailId: string, zielId: string) {
    await supabase.from("messages").update({ akte_id: zielId === "keine" ? null : zielId }).eq("id", mailId);
    if (zielId !== "keine") await supabase.from("akten").update({ zuletzt_aktiv: new Date().toISOString() }).eq("id", zielId);
    await laden();
  }

  if (!akte) return <Seite titel="Akte">Lädt …</Seite>;
  const h = heute();
  const basis = akte.wiedervorlage_am && akte.wiedervorlage_am > h ? akte.wiedervorlage_am : h;

  return (
    <Seite titel={`${akte.nummer}`}>
      <Karte>
        <input
          defaultValue={akte.titel}
          onBlur={(e) => e.target.value.trim() && e.target.value !== akte.titel && aendern({ titel: e.target.value.trim() })}
          className="w-full text-xl font-semibold outline-none focus:underline"
          aria-label="Titel"
        />
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-stone-500">Gegenpartei</dt>
          <dd>
            {akte.gegenpartei ?? "–"}
            {akte.gegenpartei_adresse && <span className="ml-2 text-stone-400">{akte.gegenpartei_adresse}</span>}
          </dd>
          {akte.worauf && (
            <>
              <dt className="text-stone-500">Worum</dt>
              <dd>{akte.worauf}</dd>
            </>
          )}
          <dt className="text-stone-500">Bereich</dt>
          <dd>
            <select
              value={akte.bereich}
              onChange={(e) => aendern({ bereich: e.target.value as Bereich }, `Bereich auf ${bereichLabel(e.target.value as Bereich)} geändert`)}
              className="rounded border border-stone-300 px-2 py-0.5 text-sm"
            >
              {BEREICHE.map((b) => (
                <option key={b.key} value={b.key}>
                  {b.label}
                </option>
              ))}
            </select>
          </dd>
          <dt className="text-stone-500">Seit</dt>
          <dd>{datumKurz(akte.seit)}</dd>
          <dt className="text-stone-500">Stand</dt>
          <dd className="text-xs">
            <StatusMarker akte={akte} />
          </dd>
        </dl>

        {akte.status === "offen" ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Knopf onClick={() => aendern({ status: "erledigt", erledigt_am: new Date().toISOString() }, "Von Sven als erledigt markiert")} primaer>
              Erledigt
            </Knopf>
            {akte.am_zug === "sven" ? (
              <Knopf onClick={() => aendern({ am_zug: "gegenseite", wiedervorlage_am: plusTage(h, 7), erinnert_am: null }, "Sven wartet wieder auf die Gegenseite")}>
                Ich warte jetzt
              </Knopf>
            ) : (
              <Knopf onClick={() => aendern({ am_zug: "sven" }, "Sven ist am Zug")}>Ich bin dran</Knopf>
            )}
            <Knopf onClick={() => aendern({ am_zug: "gegenseite", wiedervorlage_am: plusTage(basis, 7), erinnert_am: null }, `Wiedervorlage auf ${datumKurz(plusTage(basis, 7))}`)}>
              WV +7 Tage
            </Knopf>
            <label className="flex items-center gap-1 text-xs text-stone-500">
              Wiedervorlage
              <input
                type="date"
                value={akte.wiedervorlage_am ?? ""}
                min={h}
                onChange={(e) =>
                  e.target.value &&
                  aendern({ am_zug: "gegenseite", wiedervorlage_am: e.target.value, erinnert_am: null }, `Wiedervorlage auf ${datumKurz(e.target.value)}`)
                }
                className="rounded border border-stone-300 px-2 py-1 text-sm"
              />
            </label>
          </div>
        ) : (
          <div className="mt-4">
            <Knopf onClick={() => aendern({ status: "offen", erledigt_am: null }, "Wieder eröffnet")}>Wieder eröffnen</Knopf>
          </div>
        )}
        {akte.status === "offen" && andere.length > 0 && (
          <div className="mt-4 border-t border-stone-100 pt-3 text-sm">
            <label className="flex flex-wrap items-center gap-2 text-stone-500">
              Gleiche Sache wie
              <select
                value=""
                onChange={(e) => e.target.value && zusammenfuehren(e.target.value)}
                className="rounded border border-stone-300 px-2 py-1 text-sm text-stone-800"
              >
                <option value="">andere Akte wählen …</option>
                {andere.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nummer} {a.titel}
                  </option>
                ))}
              </select>
              → zusammenführen
            </label>
          </div>
        )}
      </Karte>

      <h2 className="mb-3 mt-8 text-lg font-semibold">Verlauf</h2>
      <form onSubmit={notizSpeichern} className="mb-4 flex gap-2">
        <input
          value={notiz}
          onChange={(e) => setNotiz(e.target.value)}
          placeholder="Notiz hinzufügen, z. B. «Mit Bank telefoniert, Rückruf Montag»"
          className="min-w-0 flex-1 rounded border border-stone-300 px-3 py-2 text-sm"
        />
        <Knopf onClick={() => {}} typ="submit" primaer>
          Speichern
        </Knopf>
      </form>
      <div className="flex flex-col gap-3">
        {verlauf.length === 0 && <p className="text-sm text-stone-500">Noch keine Einträge.</p>}
        {verlauf.map((v) =>
          v.mail ? (
            <Karte key={v.mail.id}>
              <MailKopf mail={v.mail} />
              <label className="mt-2 flex items-center gap-2 text-xs text-stone-500">
                Umbuchen nach
                <select
                  value=""
                  onChange={(e) => e.target.value && mailUmbuchen(v.mail!.id, e.target.value)}
                  className="rounded border border-stone-300 px-1.5 py-0.5"
                >
                  <option value="">…</option>
                  {andere.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.nummer} {a.titel}
                    </option>
                  ))}
                  <option value="keine">aus Akte entfernen</option>
                </select>
              </label>
            </Karte>
          ) : (
            <div key={v.eintrag!.id} className={`rounded-lg px-4 py-2 text-sm ${v.eintrag!.typ === "notiz" ? "border border-amber-200 bg-amber-50" : "text-stone-500"}`}>
              <span className="mr-2 text-xs text-stone-400">{zeit(v.eintrag!.erstellt_am)}</span>
              {v.eintrag!.typ === "notiz" && <span className="mr-1 font-medium">Notiz:</span>}
              {v.eintrag!.text}
            </div>
          ),
        )}
      </div>
    </Seite>
  );
}

function Seite({ titel, children }: { titel: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <a href="#/" className="text-sm text-stone-500 underline">
        ← Heute
      </a>
      <h1 className="mb-6 mt-2 text-3xl font-semibold">{titel}</h1>
      {children}
    </main>
  );
}

function BereichWahl({ wert, setWert }: { wert: Bereich; setWert: (b: Bereich) => void }) {
  return (
    <select
      value={wert}
      onChange={(e) => setWert(e.target.value as Bereich)}
      className="rounded border border-stone-300 px-3 py-2 text-sm"
      aria-label="Bereich"
    >
      {BEREICHE.map((b) => (
        <option key={b.key} value={b.key}>
          {b.label}
        </option>
      ))}
    </select>
  );
}
