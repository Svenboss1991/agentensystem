import { useCallback, useEffect, useState } from "react";
import BereichFilter from "./BereichFilter";
import { BEREICHE, bereichLabel, funktion, supabase, type Bereich } from "./lib/supabase";
import { Seite } from "./Seite";
import { Karte, Knopf } from "./ui";

export const TYPEN = [
  { key: "vertrag", label: "Vertrag" },
  { key: "police", label: "Versicherungspolice" },
  { key: "rechnung", label: "Rechnung" },
  { key: "ausweis", label: "Ausweis" },
  { key: "bescheinigung", label: "Bescheinigung" },
  { key: "korrespondenz", label: "Korrespondenz" },
  { key: "sonstiges", label: "Sonstiges" },
] as const;

const typLabel = (t: string) => TYPEN.find((x) => x.key === t)?.label ?? t;
const datumKurz = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("de-CH", { timeZone: "UTC" });

interface Dokument {
  id: string;
  titel: string;
  typ: string;
  bereich: Bereich;
  datei_pfad: string;
  datei_name: string | null;
  groesse: number | null;
  gueltig_bis: string | null;
  erinnern_am: string | null;
  notiz: string | null;
  erstellt_am: string;
  firmen: { id: string; name: string } | null;
  kontakte: { id: string; name: string | null; email: string | null } | null;
  akten: { id: string; nummer: string } | null;
  auswertung: Analyse | null;
  analyse_status: "laeuft" | "fertig" | "fehler" | null;
  analyse_fehler: string | null;
}

interface Analyse {
  zusammenfassung: string;
  art: string | null;
  anbieter: string | null;
  nummer: string | null;
  versichert: string | null;
  praemie_betrag: number | null;
  praemie_waehrung: string | null;
  praemie_intervall: string | null;
  beginn: string | null;
  ende: string | null;
  verlaengerung: string | null;
  kuendigungsfrist: string | null;
  kuendbar_bis: string | null;
  gedeckt: { was: string; summe: string | null; selbstbehalt: string | null }[];
  nicht_gedeckt: string[];
  pflichten: string[];
  pruefen: string[];
}

const FELDER =
  "id, titel, typ, bereich, datei_pfad, datei_name, groesse, gueltig_bis, erinnern_am, notiz, erstellt_am, auswertung, analyse_status, analyse_fehler, firmen(id, name), kontakte(id, name, email), akten(id, nummer)";

const praemieText = (a: Analyse | null | undefined) =>
  a?.praemie_betrag != null
    ? `${a.praemie_waehrung ?? ""} ${a.praemie_betrag.toLocaleString("de-CH", { minimumFractionDigits: 2 })} ${a.praemie_intervall ?? ""}`.trim()
    : null;

/** Claude liest Police oder Vertrag; danach ist die Analyse beim Dokument sichtbar. */
async function analysieren(id: string): Promise<void> {
  await funktion("dokument-analysieren", { dokument_id: id });
}

function AnalyseAnsicht({ a }: { a: Analyse }) {
  const liste = (titel: string, punkte: string[], farbe = "") =>
    punkte.length > 0 && (
      <div className="mt-2">
        <p className="text-xs font-medium uppercase tracking-wide text-stone-500">{titel}</p>
        <ul className={`ml-4 list-disc ${farbe}`}>
          {punkte.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      </div>
    );
  const zeile = (label: string, wert: string | null | undefined) =>
    wert && (
      <>
        <dt className="text-stone-500">{label}</dt>
        <dd>{wert}</dd>
      </>
    );
  return (
    <div className="mt-2 rounded bg-stone-50 p-3 text-sm">
      <p>{a.zusammenfassung}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {zeile("Art", a.art)}
        {zeile("Anbieter", a.anbieter)}
        {zeile("Nummer", a.nummer)}
        {zeile("Versichert", a.versichert)}
        {zeile("Prämie / Kosten", praemieText(a))}
        {zeile("Laufzeit", [a.beginn && datumKurz(a.beginn), a.ende && datumKurz(a.ende)].filter(Boolean).join(" – ") || null)}
        {zeile("Verlängerung", a.verlaengerung)}
        {zeile("Kündigungsfrist", a.kuendigungsfrist)}
        {zeile("Kündbar bis", a.kuendbar_bis && datumKurz(a.kuendbar_bis))}
      </dl>
      {a.gedeckt.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">Gedeckt</p>
          <table className="mt-1 w-full text-xs">
            <tbody>
              {a.gedeckt.map((g, i) => (
                <tr key={i} className="border-t border-stone-200 align-top">
                  <td className="py-1 pr-2">{g.was}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{g.summe ?? ""}</td>
                  <td className="py-1 text-right text-stone-500">{g.selbstbehalt ? `SB ${g.selbstbehalt}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {liste("Nicht gedeckt", a.nicht_gedeckt, "text-red-800")}
      {liste("Deine Pflichten", a.pflichten)}
      {liste("Zum Prüfen", a.pruefen, "text-amber-800")}
      <p className="mt-2 text-xs text-stone-400">Zusammenfassung von Claude, keine Beratung. Massgebend ist das Dokument.</p>
    </div>
  );
}

async function oeffnen(d: Dokument) {
  const { data, error } = await supabase.storage.from("dokumente").createSignedUrl(d.datei_pfad, 300);
  if (error || !data) return window.alert(error?.message ?? "Datei nicht gefunden");
  window.open(data.signedUrl, "_blank", "noopener");
}

async function loeschen(d: Dokument, fertig: () => void) {
  if (!window.confirm(`«${d.titel}» endgültig löschen?`)) return;
  await supabase.storage.from("dokumente").remove([d.datei_pfad]);
  await supabase.from("dokumente").delete().eq("id", d.id);
  fertig();
}

/** Dokumente einer Firma, Person oder Akte (oder alle) mit Hochladen. */
export function DokumenteListe({
  firmaId,
  kontaktId,
  akteId,
  bereich = "privat",
  filter,
}: {
  firmaId?: string;
  kontaktId?: string;
  akteId?: string;
  bereich?: Bereich;
  filter?: (d: Dokument) => boolean;
}) {
  const [liste, setListe] = useState<Dokument[]>([]);
  const [neu, setNeu] = useState(false);
  const [offen, setOffen] = useState<string | null>(null);
  const [analysiert, setAnalysiert] = useState<string | null>(null);

  const laden = useCallback(async () => {
    let q = supabase.from("dokumente").select(FELDER).order("erstellt_am", { ascending: false });
    if (firmaId) q = q.eq("firma_id", firmaId);
    if (kontaktId) q = q.eq("kontakt_id", kontaktId);
    if (akteId) q = q.eq("akte_id", akteId);
    const { data } = await q;
    setListe((data ?? []) as unknown as Dokument[]);
  }, [firmaId, kontaktId, akteId]);

  useEffect(() => {
    laden();
  }, [laden]);

  async function starten(id: string) {
    setAnalysiert(id);
    try {
      await analysieren(id);
      setOffen(id);
    } catch {
      // Fehler steht danach beim Dokument.
    }
    setAnalysiert(null);
    await laden();
  }

  const sichtbar = filter ? liste.filter(filter) : liste;
  const allgemein = !firmaId && !kontaktId && !akteId;

  return (
    <div className="flex flex-col gap-3">
      {neu ? (
        <Hochladen
          firmaId={firmaId}
          kontaktId={kontaktId}
          akteId={akteId}
          bereich={bereich}
          fertig={(id, typ) => {
            setNeu(false);
            laden();
            if (id && (typ === "police" || typ === "vertrag")) starten(id);
          }}
        />
      ) : (
        <div>
          <Knopf onClick={() => setNeu(true)} primaer={allgemein}>
            + Dokument hochladen
          </Knopf>
        </div>
      )}
      {sichtbar.length > 0 ? (
        <Karte>
          <div className="divide-y divide-stone-100">
            {sichtbar.map((d) => (
              <div key={d.id} className="flex flex-wrap items-start gap-2 py-2 text-sm first:pt-0 last:pb-0">
                <button onClick={() => oeffnen(d)} className="min-w-0 flex-1 text-left">
                  <span className="font-medium underline decoration-stone-300">{d.titel}</span>
                  <span className="ml-2 text-xs text-stone-400">{typLabel(d.typ)}</span>
                  <span className="block text-xs text-stone-500">
                    {[
                      allgemein && bereichLabel(d.bereich),
                      d.firmen?.name,
                      d.kontakte?.name ?? d.kontakte?.email,
                      d.akten?.nummer,
                      d.gueltig_bis && `gültig bis ${datumKurz(d.gueltig_bis)}`,
                      d.erinnern_am && `Erinnerung ${datumKurz(d.erinnern_am)}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {d.notiz && <span className="block text-xs text-stone-500">{d.notiz}</span>}
                </button>
                <span className="flex gap-3 text-xs">
                  {d.analyse_status === "fertig" ? (
                    <button onClick={() => setOffen(offen === d.id ? null : d.id)} className="underline">
                      {offen === d.id ? "Analyse schliessen" : "Analyse"}
                    </button>
                  ) : d.analyse_status === "laeuft" || analysiert === d.id ? (
                    <span className="text-stone-500">wird analysiert …</span>
                  ) : (
                    <button onClick={() => starten(d.id)} className="underline">
                      {d.analyse_status === "fehler" ? "nochmals analysieren" : "analysieren"}
                    </button>
                  )}
                  <button onClick={() => loeschen(d, laden)} className="text-stone-400 underline">
                    löschen
                  </button>
                </span>
                {d.analyse_status === "fehler" && d.analyse_fehler && (
                  <p className="w-full text-xs text-red-700">{d.analyse_fehler}</p>
                )}
                {offen === d.id && d.auswertung && (
                  <div className="w-full">
                    <AnalyseAnsicht a={d.auswertung} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </Karte>
      ) : (
        <p className="text-sm text-stone-500">Noch keine Dokumente.</p>
      )}
    </div>
  );
}

function Hochladen({
  firmaId,
  kontaktId,
  akteId,
  bereich: startBereich,
  fertig,
}: {
  firmaId?: string;
  kontaktId?: string;
  akteId?: string;
  bereich: Bereich;
  fertig: (id?: string, typ?: string) => void;
}) {
  const [datei, setDatei] = useState<File | null>(null);
  const [titel, setTitel] = useState("");
  const [typ, setTyp] = useState("vertrag");
  const [bereich, setBereich] = useState<Bereich>(startBereich);
  const [firma, setFirma] = useState(firmaId ?? "");
  const [firmen, setFirmen] = useState<{ id: string; name: string }[]>([]);
  const [gueltigBis, setGueltigBis] = useState("");
  const [erinnern, setErinnern] = useState("");
  const [notiz, setNotiz] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (firmaId) return;
    supabase
      .from("firmen")
      .select("id, name")
      .order("name")
      .then(({ data }) => setFirmen((data ?? []) as { id: string; name: string }[]));
  }, [firmaId]);

  async function speichern(e: React.FormEvent) {
    e.preventDefault();
    if (!datei) return;
    setStatus("Lädt hoch …");
    const pfad = `${crypto.randomUUID()}/${datei.name.replace(/[^\w.\-äöüÄÖÜ ]/g, "_")}`;
    const { error } = await supabase.storage.from("dokumente").upload(pfad, datei, { contentType: datei.type || undefined });
    if (error) return setStatus(error.message);
    const { data: neu, error: e2 } = await supabase.from("dokumente").insert({
      titel: titel || datei.name,
      typ,
      bereich,
      datei_pfad: pfad,
      datei_name: datei.name,
      groesse: datei.size,
      mime: datei.type || null,
      firma_id: firma || null,
      kontakt_id: kontaktId ?? null,
      akte_id: akteId ?? null,
      gueltig_bis: gueltigBis || null,
      erinnern_am: erinnern || null,
      notiz: notiz || null,
    }).select("id").single();
    if (e2) return setStatus(e2.message);
    fertig(neu?.id, typ);
  }

  const feld = "rounded border border-stone-300 px-3 py-2 text-sm";
  return (
    <Karte>
      <form onSubmit={speichern} className="grid gap-2 sm:grid-cols-2">
        <input
          type="file"
          required
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setDatei(f);
            if (f && !titel) setTitel(f.name.replace(/\.[^.]+$/, ""));
          }}
          className="text-sm sm:col-span-2"
        />
        <input value={titel} onChange={(e) => setTitel(e.target.value)} placeholder="Titel, z. B. Hausratversicherung Mobiliar" className={`${feld} sm:col-span-2`} />
        <select value={typ} onChange={(e) => setTyp(e.target.value)} className={feld} aria-label="Typ">
          {TYPEN.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
        <select value={bereich} onChange={(e) => setBereich(e.target.value as Bereich)} className={feld} aria-label="Bereich">
          {BEREICHE.map((b) => (
            <option key={b.key} value={b.key}>
              {b.label}
            </option>
          ))}
        </select>
        {!firmaId && (
          <select value={firma} onChange={(e) => setFirma(e.target.value)} className={`${feld} sm:col-span-2`} aria-label="Firma">
            <option value="">Firma (optional)</option>
            {firmen.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        )}
        <label className="text-xs text-stone-500">
          Gültig bis (optional)
          <input type="date" value={gueltigBis} onChange={(e) => setGueltigBis(e.target.value)} className={`${feld} mt-1 w-full`} />
        </label>
        <label className="text-xs text-stone-500">
          Erinnern am, z. B. Kündigungsfrist (optional)
          <input type="date" value={erinnern} onChange={(e) => setErinnern(e.target.value)} className={`${feld} mt-1 w-full`} />
        </label>
        <input value={notiz} onChange={(e) => setNotiz(e.target.value)} placeholder="Notiz, z. B. Policennummer" className={`${feld} sm:col-span-2`} />
        <div className="flex items-center gap-2 sm:col-span-2">
          <Knopf onClick={() => {}} typ="submit" primaer disabled={!datei || status === "Lädt hoch …"}>
            Speichern
          </Knopf>
          <Knopf onClick={() => fertig()}>Abbrechen</Knopf>
          {status && <span className="text-xs text-stone-600">{status}</span>}
        </div>
      </form>
    </Karte>
  );
}

/** Seite «Dokumente»: alle Dokumente, nach Bereich und Typ filterbar, mit Suche. */
export function DokumenteSeite() {
  const [bereich, setBereich] = useState<Bereich | null>(null);
  const [typ, setTyp] = useState("");
  const [suche, setSuche] = useState("");
  const s = suche.trim().toLowerCase();

  return (
    <Seite titel="Dokumente">
      <div className="mb-3">
        <BereichFilter wert={bereich} setWert={setBereich} />
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        <select value={typ} onChange={(e) => setTyp(e.target.value)} className="rounded border border-stone-300 px-2 py-1.5 text-sm">
          <option value="">Alle Typen</option>
          {TYPEN.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
        <input
          value={suche}
          onChange={(e) => setSuche(e.target.value)}
          placeholder="Suchen (Titel, Firma, Notiz)"
          className="min-w-0 flex-1 rounded border border-stone-300 px-3 py-1.5 text-sm"
        />
      </div>
      <Versicherungen />
      <DokumenteListe
        bereich={bereich ?? "privat"}
        filter={(d) =>
          (!bereich || d.bereich === bereich) &&
          (!typ || d.typ === typ) &&
          (!s || [d.titel, d.firmen?.name, d.notiz, d.kontakte?.name].some((x) => x?.toLowerCase().includes(s)))
        }
      />
    </Seite>
  );
}

/** Überblick über alle analysierten Policen: Art, Versicherer, Prämie, Kündbar bis. */
function Versicherungen() {
  const [policen, setPolicen] = useState<Dokument[]>([]);
  useEffect(() => {
    supabase
      .from("dokumente")
      .select(FELDER)
      .eq("typ", "police")
      .eq("analyse_status", "fertig")
      .order("titel")
      .then(({ data }) => setPolicen((data ?? []) as unknown as Dokument[]));
  }, []);
  if (!policen.length) return null;
  return (
    <div className="mb-6">
      <h2 className="mb-2 text-lg font-semibold">Meine Versicherungen</h2>
      <Karte>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-stone-500">
              <th className="pb-1 font-normal">Art</th>
              <th className="pb-1 font-normal">Versicherer</th>
              <th className="pb-1 text-right font-normal">Prämie</th>
              <th className="pb-1 text-right font-normal">Kündbar bis</th>
            </tr>
          </thead>
          <tbody>
            {policen.map((d) => (
              <tr key={d.id} className="border-t border-stone-100">
                <td className="py-1.5 pr-2">{d.auswertung?.art ?? d.titel}</td>
                <td className="py-1.5 pr-2">{d.auswertung?.anbieter ?? d.firmen?.name ?? ""}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{praemieText(d.auswertung) ?? ""}</td>
                <td className="py-1.5 text-right">{d.auswertung?.kuendbar_bis ? datumKurz(d.auswertung.kuendbar_bis) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-stone-400">Was genau gedeckt ist, siehst du unten bei der jeweiligen Police unter «Analyse».</p>
      </Karte>
    </div>
  );
}
