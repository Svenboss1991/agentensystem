import { useEffect, useState } from "react";
import type { Postfach } from "./Heute";
import { MARKEN, oauthStarten, zeit } from "./lib/supabase";
import { Abschnitt, Karte, Knopf } from "./ui";

/** Status aller Postfächer; Gmail/Hotmail lassen sich hier verbinden. */
export default function Postfaecher({ postfaecher }: { postfaecher: Postfach[] }) {
  const [meldung, setMeldung] = useState<{ ok: boolean; text: string } | null>(null);
  const [verbindet, setVerbindet] = useState<string | null>(null);

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
              </li>
            );
          })}
        </ul>
      </Karte>
    </Abschnitt>
  );
}
