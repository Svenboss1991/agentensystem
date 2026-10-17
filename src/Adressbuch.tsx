import { useCallback, useEffect, useState } from "react";
import { DokumenteListe } from "./Dokumente";
import { BEREICHE, supabase, zeit, type Bereich } from "./lib/supabase";
import { MAIL_FELDER, MailKopf, type Mail } from "./Mail";
import { Seite } from "./Seite";
import { Karte, Knopf } from "./ui";

interface Firma {
  id: string;
  name: string;
  domains: string[];
  bereich: Bereich;
  telefon: string | null;
  website: string | null;
  adresse: string | null;
  notiz: string | null;
}

interface Kontakt {
  id: string;
  name: string | null;
  email: string | null;
  telefon: string | null;
  mobil: string | null;
  position: string | null;
  firma_id: string | null;
  notiz: string | null;
  letzter_kontakt: string | null;
  firmen?: { id: string; name: string } | null;
}

const KONTAKT_FELDER = "id, name, email, telefon, mobil, position, firma_id, notiz, letzter_kontakt, firmen(id, name)";
const FIRMA_FELDER = "id, name, domains, bereich, telefon, website, adresse, notiz";
const feld = "rounded border border-stone-300 px-3 py-2 text-sm";

function KontaktZeile({ k, mitFirma = true }: { k: Kontakt; mitFirma?: boolean }) {
  return (
    <a href={`#/kontakt/${k.id}`} className="flex flex-wrap items-baseline justify-between gap-2 py-2 first:pt-0 last:pb-0 hover:bg-stone-50">
      <span>
        <span className="font-medium">{k.name || k.email}</span>
        {k.position && <span className="ml-2 text-xs text-stone-500">{k.position}</span>}
        {mitFirma && k.firmen && <span className="ml-2 text-sm text-stone-500">{k.firmen.name}</span>}
        {k.name && k.email && <span className="block text-xs text-stone-400">{k.email}</span>}
      </span>
      <span className="text-xs text-stone-500">{k.mobil || k.telefon || ""}</span>
    </a>
  );
}

// ─── Adressbuch: Suche über Firmen und Personen ──────────────────────────────

export function AdressbuchSeite() {
  const [suche, setSuche] = useState("");
  const [firmen, setFirmen] = useState<(Firma & { kontakte: { count: number }[] })[]>([]);
  const [kontakte, setKontakte] = useState<Kontakt[]>([]);
  const [neu, setNeu] = useState<"" | "person" | "firma">("");

  useEffect(() => {
    const s = suche.trim().replace(/[%,()]/g, "");
    const t = setTimeout(async () => {
      let fq = supabase.from("firmen").select(`${FIRMA_FELDER}, kontakte(count)`).order("name").limit(50);
      let kq = supabase.from("kontakte").select(KONTAKT_FELDER).order("letzter_kontakt", { ascending: false, nullsFirst: false }).limit(100);
      if (s) {
        fq = fq.or(`name.ilike.%${s}%,notiz.ilike.%${s}%`);
        // Personen: direkter Treffer oder Mitarbeitende einer passenden Firma (z. B. «HSBC»).
        const { data: passendeFirmen } = await supabase.from("firmen").select("id").ilike("name", `%${s}%`);
        const ids = (passendeFirmen ?? []).map((f) => f.id);
        kq = kq.or(
          [
            `name.ilike.%${s}%`,
            `email.ilike.%${s}%`,
            `telefon.ilike.%${s}%`,
            `mobil.ilike.%${s}%`,
            `position.ilike.%${s}%`,
            ids.length ? `firma_id.in.(${ids.join(",")})` : null,
          ]
            .filter(Boolean)
            .join(","),
        );
      }
      const [f, k] = await Promise.all([fq, kq]);
      setFirmen((f.data ?? []) as unknown as (Firma & { kontakte: { count: number }[] })[]);
      setKontakte((k.data ?? []) as unknown as Kontakt[]);
    }, 250);
    return () => clearTimeout(t);
  }, [suche]);

  return (
    <Seite titel="Adressbuch">
      <div className="mb-4 flex flex-wrap gap-2">
        <input
          autoFocus
          value={suche}
          onChange={(e) => setSuche(e.target.value)}
          placeholder="Suchen: Name, Firma, Mail, Telefon …"
          className="min-w-0 flex-1 rounded border border-stone-300 px-3 py-2 text-sm"
        />
        <Knopf onClick={() => setNeu("person")}>+ Person</Knopf>
        <Knopf onClick={() => setNeu("firma")}>+ Firma</Knopf>
      </div>
      {neu && <NeuerEintrag art={neu} abbrechen={() => setNeu("")} />}

      <h2 className="mb-2 text-lg font-semibold">Firmen</h2>
      <Karte>
        {firmen.length ? (
          <div className="divide-y divide-stone-100">
            {firmen.map((f) => (
              <a key={f.id} href={`#/firma/${f.id}`} className="flex items-baseline justify-between gap-2 py-2 first:pt-0 last:pb-0 hover:bg-stone-50">
                <span className="font-medium">{f.name}</span>
                <span className="text-xs text-stone-500">
                  {f.kontakte?.[0]?.count ?? 0} Personen{f.telefon ? ` · ${f.telefon}` : ""}
                </span>
              </a>
            ))}
          </div>
        ) : (
          <p className="text-sm text-stone-500">Keine Firmen gefunden.</p>
        )}
      </Karte>

      <h2 className="mb-2 mt-6 text-lg font-semibold">Personen</h2>
      <Karte>
        {kontakte.length ? (
          <div className="divide-y divide-stone-100">
            {kontakte.map((k) => (
              <KontaktZeile key={k.id} k={k} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-stone-500">Keine Personen gefunden.</p>
        )}
      </Karte>
    </Seite>
  );
}

function NeuerEintrag({ art, abbrechen }: { art: "person" | "firma"; abbrechen: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [telefon, setTelefon] = useState("");

  async function speichern(e: React.FormEvent) {
    e.preventDefault();
    if (art === "firma") {
      const { data } = await supabase.from("firmen").insert({ name, telefon: telefon || null }).select("id").single();
      if (data) window.location.hash = `#/firma/${data.id}`;
    } else {
      const { data } = await supabase
        .from("kontakte")
        .insert({ name, email: email.trim().toLowerCase() || null, telefon: telefon || null, quelle: "sven" })
        .select("id")
        .single();
      if (data) window.location.hash = `#/kontakt/${data.id}`;
    }
  }

  return (
    <div className="mb-6">
      <Karte>
        <form onSubmit={speichern} className="grid gap-2 sm:grid-cols-3">
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder={art === "firma" ? "Firmenname" : "Name"} className={feld} />
          {art === "person" && <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-Mail" className={feld} />}
          <input value={telefon} onChange={(e) => setTelefon(e.target.value)} placeholder="Telefon" className={feld} />
          <div className="flex gap-2 sm:col-span-3">
            <Knopf onClick={() => {}} typ="submit" primaer>
              Anlegen
            </Knopf>
            <Knopf onClick={abbrechen}>Abbrechen</Knopf>
          </div>
        </form>
      </Karte>
    </div>
  );
}

/** Felder bearbeiten und mit einem Klick speichern. */
function Formular<T extends Record<string, unknown>>({
  werte,
  felder,
  speichern,
}: {
  werte: T;
  felder: { key: keyof T & string; label: string; breit?: boolean; mehrzeilig?: boolean }[];
  speichern: (neu: Partial<T>) => Promise<void>;
}) {
  const [entwurf, setEntwurf] = useState<Partial<T>>({});
  const [gespeichert, setGespeichert] = useState(false);
  const geaendert = Object.keys(entwurf).length > 0;
  const wert = (k: keyof T & string) => (k in entwurf ? entwurf[k] : werte[k]) as string | null;

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        await speichern(entwurf);
        setEntwurf({});
        setGespeichert(true);
      }}
      className="grid gap-2 sm:grid-cols-2"
    >
      {felder.map((f) => (
        <label key={f.key} className={`text-xs text-stone-500 ${f.breit ? "sm:col-span-2" : ""}`}>
          {f.label}
          {f.mehrzeilig ? (
            <textarea
              value={wert(f.key) ?? ""}
              onChange={(e) => setEntwurf((x) => ({ ...x, [f.key]: e.target.value || null }))}
              rows={3}
              className={`${feld} mt-1 w-full text-stone-900`}
            />
          ) : (
            <input
              value={wert(f.key) ?? ""}
              onChange={(e) => setEntwurf((x) => ({ ...x, [f.key]: e.target.value || null }))}
              className={`${feld} mt-1 w-full text-stone-900`}
            />
          )}
        </label>
      ))}
      <div className="flex items-center gap-2 sm:col-span-2">
        <Knopf onClick={() => {}} typ="submit" primaer disabled={!geaendert}>
          Speichern
        </Knopf>
        {gespeichert && !geaendert && <span className="text-xs text-green-700">gespeichert</span>}
      </div>
    </form>
  );
}

function MailsListe({ filter }: { filter: { spalte: "kontakt_id"; werte: string[] } }) {
  const [mails, setMails] = useState<Mail[]>([]);
  const schluessel = filter.werte.join(",");
  useEffect(() => {
    if (!filter.werte.length) return setMails([]);
    supabase
      .from("messages")
      .select(MAIL_FELDER)
      .in(filter.spalte, filter.werte)
      .order("empfangen_am", { ascending: false })
      .limit(50)
      .then(({ data }) => setMails((data ?? []) as unknown as Mail[]));
  }, [schluessel]);

  if (!mails.length) return <p className="text-sm text-stone-500">Noch keine Mails.</p>;
  return (
    <div className="flex flex-col gap-3">
      {mails.map((m) => (
        <Karte key={m.id}>
          <MailKopf mail={m} />
        </Karte>
      ))}
    </div>
  );
}

// ─── Person ──────────────────────────────────────────────────────────────────

export function KontaktSeite({ id }: { id: string }) {
  const [k, setK] = useState<Kontakt | null>(null);
  const [firmen, setFirmen] = useState<{ id: string; name: string }[]>([]);

  const laden = useCallback(async () => {
    const [a, f] = await Promise.all([
      supabase.from("kontakte").select(KONTAKT_FELDER).eq("id", id).single(),
      supabase.from("firmen").select("id, name").order("name"),
    ]);
    setK(a.data as unknown as Kontakt);
    setFirmen((f.data ?? []) as { id: string; name: string }[]);
  }, [id]);

  useEffect(() => {
    laden();
  }, [laden]);

  if (!k) return <Seite titel="Person">Lädt …</Seite>;
  return (
    <Seite titel={k.name || k.email || "Person"}>
      <Karte>
        <Formular
          werte={k as unknown as Record<string, unknown>}
          felder={[
            { key: "name", label: "Name" },
            { key: "position", label: "Position" },
            { key: "email", label: "E-Mail" },
            { key: "telefon", label: "Telefon" },
            { key: "mobil", label: "Mobil" },
            { key: "notiz", label: "Notiz", breit: true, mehrzeilig: true },
          ]}
          speichern={async (neu) => {
            if (typeof neu.email === "string") neu.email = neu.email.trim().toLowerCase();
            await supabase.from("kontakte").update({ ...neu, aktualisiert_am: new Date().toISOString() }).eq("id", id);
            await laden();
          }}
        />
        <label className="mt-3 flex items-center gap-2 text-xs text-stone-500">
          Firma
          <select
            value={k.firma_id ?? ""}
            onChange={async (e) => {
              await supabase.from("kontakte").update({ firma_id: e.target.value || null }).eq("id", id);
              await laden();
            }}
            className="rounded border border-stone-300 px-2 py-1 text-sm text-stone-900"
          >
            <option value="">keine</option>
            {firmen.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          {k.firmen && (
            <a href={`#/firma/${k.firmen.id}`} className="underline">
              öffnen
            </a>
          )}
        </label>
        {k.letzter_kontakt && <p className="mt-2 text-xs text-stone-400">Letzter Kontakt {zeit(k.letzter_kontakt)}</p>}
      </Karte>

      <h2 className="mb-3 mt-8 text-lg font-semibold">Dokumente</h2>
      <DokumenteListe kontaktId={id} />

      <h2 className="mb-3 mt-8 text-lg font-semibold">Mails</h2>
      <MailsListe filter={{ spalte: "kontakt_id", werte: [id] }} />
    </Seite>
  );
}

// ─── Firma ───────────────────────────────────────────────────────────────────

export function FirmaSeite({ id }: { id: string }) {
  const [f, setF] = useState<Firma | null>(null);
  const [personen, setPersonen] = useState<Kontakt[]>([]);

  const laden = useCallback(async () => {
    const [a, k] = await Promise.all([
      supabase.from("firmen").select(FIRMA_FELDER).eq("id", id).single(),
      supabase.from("kontakte").select(KONTAKT_FELDER).eq("firma_id", id).order("name"),
    ]);
    setF(a.data as Firma);
    setPersonen((k.data ?? []) as unknown as Kontakt[]);
  }, [id]);

  useEffect(() => {
    laden();
  }, [laden]);

  if (!f) return <Seite titel="Firma">Lädt …</Seite>;
  return (
    <Seite titel={f.name}>
      <Karte>
        <Formular
          werte={f as unknown as Record<string, unknown>}
          felder={[
            { key: "name", label: "Name" },
            { key: "telefon", label: "Telefon" },
            { key: "website", label: "Website" },
            { key: "adresse", label: "Adresse" },
            { key: "notiz", label: "Notiz (z. B. Kundennummer, Ansprechpartner)", breit: true, mehrzeilig: true },
          ]}
          speichern={async (neu) => {
            await supabase.from("firmen").update({ ...neu, aktualisiert_am: new Date().toISOString() }).eq("id", id);
            await laden();
          }}
        />
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-stone-500">
          Bereich
          <select
            value={f.bereich}
            onChange={async (e) => {
              await supabase.from("firmen").update({ bereich: e.target.value }).eq("id", id);
              await laden();
            }}
            className="rounded border border-stone-300 px-2 py-1 text-sm text-stone-900"
          >
            {BEREICHE.map((b) => (
              <option key={b.key} value={b.key}>
                {b.label}
              </option>
            ))}
          </select>
          {f.domains.length > 0 && <span className="ml-2">Mail-Domains: {f.domains.join(", ")}</span>}
        </div>
      </Karte>

      <h2 className="mb-3 mt-8 text-lg font-semibold">Personen ({personen.length})</h2>
      <Karte>
        {personen.length ? (
          <div className="divide-y divide-stone-100">
            {personen.map((k) => (
              <KontaktZeile key={k.id} k={k} mitFirma={false} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-stone-500">Noch keine Personen.</p>
        )}
      </Karte>

      <h2 className="mb-3 mt-8 text-lg font-semibold">Dokumente</h2>
      <DokumenteListe firmaId={id} bereich={f.bereich} />

      <h2 className="mb-3 mt-8 text-lg font-semibold">Mails</h2>
      <MailsListe filter={{ spalte: "kontakt_id", werte: personen.map((p) => p.id) }} />
    </Seite>
  );
}
