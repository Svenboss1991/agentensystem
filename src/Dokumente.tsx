import { useCallback, useEffect, useState } from "react";
import BereichFilter from "./BereichFilter";
import { BEREICHE, bereichLabel, supabase, type Bereich } from "./lib/supabase";
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
}

const FELDER =
  "id, titel, typ, bereich, datei_pfad, datei_name, groesse, gueltig_bis, erinnern_am, notiz, erstellt_am, firmen(id, name), kontakte(id, name, email), akten(id, nummer)";

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
          fertig={() => {
            setNeu(false);
            laden();
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
                <button onClick={() => loeschen(d, laden)} className="text-xs text-stone-400 underline">
                  löschen
                </button>
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
  fertig: () => void;
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
    const { error: e2 } = await supabase.from("dokumente").insert({
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
    });
    if (e2) return setStatus(e2.message);
    fertig();
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
          <Knopf onClick={fertig}>Abbrechen</Knopf>
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
