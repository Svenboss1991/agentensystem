import { useEffect, useState } from "react";
import type { Postfach } from "./Heute";
import { MARKEN, oauthStarten, supabase, zeit } from "./lib/supabase";
import Aufraeumen from "./Aufraeumen";
import JetztAufraeumen from "./JetztAufraeumen";
import { Abschnitt, Karte, Knopf } from "./ui";

/** Status aller Postfächer; Gmail/Hotmail lassen sich hier verbinden. */
export default function Postfaecher({ postfaecher, neuLaden }: { postfaecher: Postfach[]; neuLaden: () => void }) {
  const [meldung, setMeldung] = useState<{ ok: boolean; text: string } | null>(null);
  const [verbindet, setVerbindet] = useState<string | null>(null);
  const [aufraeumen, setAufraeumen] = useState<string | null>(null);
  const [putz, setPutz] = useState<Record<string, { fertig: boolean; geprueft: number }>>({});

  // Stand des grossen Durchgangs je Postfach (Kategorien ohne «_woche»).
  useEffect(() => {
    supabase
      .from("aufraeum_stand")
      .select("account_id, kategorie, gepruefte_mails, durchgang_fertig_am")
      .then(({ data }) => {
        const r: Record<string, { fertig: boolean; geprueft: number; offen: number }> = {};
        for (const s of data ?? []) {
          if (String(s.kategorie).endsWith("_woche")) continue;
          const x = (r[s.account_id] ??= { fertig: true, geprueft: 0, offen: 0 });
          x.geprueft += s.gepruefte_mails ?? 0;
          if (!s.durchgang_fertig_am) x.fertig = false;
        }
        setPutz(r);
      });
  }, [postfaecher]);

  // Rückmeldung nach der Anmeldung bei Google/Microsoft (…/?verbunden=… oder ?oauth_fehler=…)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("verbunden")) setMeldung({ ok: true, text: `${q.get("verbunden")} ist verbunden.` });
    if (q.get("oauth_fehler")) setMeldung({ ok: false, text: `Verbinden fehlgeschlagen: ${q.get("oauth_fehler")}` });
    if (q.size) window.history.replaceState(null, "", "/");
  }, []);

  async function verbinden(p: Postfach) {
    setVerbindet(p.id);
    try {
      window.location.href = await oauthStarten(p.id);
    } catch (err) {
      setMeldung({ ok: false, text: err instanceof Error ? err.message : String(err) });
      setVerbindet(null);
    }
  }

  return (
    <Abschnitt nummer="⚙" titel="Postfächer">
      {meldung && (
        <p className={`text-sm ${meldung.ok ? "text-green-700" : "text-red-700"}`}>{meldung.text}</p>
      )}
      <Karte>
        <ul className="divide-y divide-stone-100">
          {postfaecher.map((p) => {
            const nichtVerbunden = p.typ === "oauth" && !p.aktiv;
            return (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
                <div className="text-sm">
                  <span className="font-medium">{p.adresse}</span>
                  <span className="ml-2 text-stone-400">{p.marke !== "keine" ? MARKEN[p.marke] : "privat"}</span>
                  <p className={`text-xs ${p.sync_fehler ? "text-red-700" : "text-stone-400"}`}>
                    {nichtVerbunden
                      ? "nicht verbunden"
                      : p.sync_fehler
                        ? p.sync_fehler
                        : p.sync_zuletzt
                          ? `zuletzt abgerufen ${zeit(p.sync_zuletzt)}`
                          : "noch nie abgerufen"}
                  </p>
                </div>
                {p.typ === "oauth" && (nichtVerbunden || p.sync_fehler) && (
                  <Knopf onClick={() => verbinden(p)} primaer disabled={verbindet === p.id}>
                    {verbindet === p.id ? "Öffnet …" : "Verbinden"}
                  </Knopf>
                )}
                {p.aktiv && p.auto_aufraeumen && (
                  <span className="text-xs text-stone-400">
                    {!putz[p.id]
                      ? "Grossputz startet in Kürze"
                      : putz[p.id].fertig
                        ? "Grossputz fertig · jeden Montag 8 Uhr die letzte Woche"
                        : `Grossputz läuft · ${putz[p.id].geprueft.toLocaleString("de-CH")} Mails geprüft`}
                  </span>
                )}
                {p.aktiv && (
                  <label className="flex items-center gap-1 text-xs text-stone-500">
                    <input
                      type="checkbox"
                      checked={p.auto_aufraeumen}
                      onChange={async (e) => {
                        await supabase.from("accounts").update({ auto_aufraeumen: e.target.checked }).eq("id", p.id);
                        neuLaden();
                      }}
                    />
                    automatisch aufräumen
                  </label>
                )}
                {p.aktiv && p.auto_aufraeumen && (
                  <select
                    value={p.aufraeum_strenge ?? "normal"}
                    onChange={async (e) => {
                      await supabase.from("accounts").update({ aufraeum_strenge: e.target.value }).eq("id", p.id);
                      neuLaden();
                    }}
                    className="rounded border border-stone-300 px-1 py-0.5 text-xs text-stone-600"
                    title="Wie streng der Agent Müll erkennt"
                  >
                    <option value="streng">streng (kaum Wichtiges hier)</option>
                    <option value="normal">normal</option>
                    <option value="vorsichtig">vorsichtig (viel Wichtiges)</option>
                  </select>
                )}
                {p.aktiv && aufraeumen !== p.id && (
                  <div className="flex items-start gap-3">
                    <button onClick={() => setAufraeumen(p.id)} className="mt-2 text-xs text-stone-400 underline">
                      Details
                    </button>
                    <JetztAufraeumen accountId={p.id} fertig={neuLaden} />
                  </div>
                )}
                {p.aktiv && aufraeumen === p.id && (
                  <div className="w-full">
                    <Aufraeumen
                      anbieter={p.typ === "imap" ? "imap" : p.provider === "gmail" ? "gmail" : "hotmail"}
                      accountId={p.id}
                      schliessen={() => setAufraeumen(null)}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Karte>
    </Abschnitt>
  );
}
