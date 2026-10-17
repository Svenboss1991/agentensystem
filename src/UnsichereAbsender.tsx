import { useEffect, useState } from "react";
import { funktion, supabase } from "./lib/supabase";
import { Abschnitt, Karte, Knopf } from "./ui";

interface Unsicher {
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

/** Der Agent räumt selbständig auf und fragt nur bei Absendern, bei denen er unsicher ist. */
export default function UnsichereAbsender({ version }: { version: unknown }) {
  const [liste, setListe] = useState<Unsicher[]>([]);
  const [aufgeraeumt, setAufgeraeumt] = useState(0);
  const [laeuft, setLaeuft] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("aufraeum_absender")
      .select("id, account_id, kategorie, adresse, name, beispiele, anzahl, grund, accounts(adresse)")
      .eq("urteil", "unsicher")
      .order("anzahl", { ascending: false })
      .limit(30)
      .then(({ data }) => setListe((data ?? []) as unknown as Unsicher[]));
    // «123 Mails in den Papierkorb …» aus dem Protokoll der letzten 7 Tage zusammenzählen.
    supabase
      .from("agent_log")
      .select("ergebnis")
      .eq("aktion", "aufgeraeumt")
      .eq("agent", "mail")
      .gte("zeit", new Date(Date.now() - 7 * 86_400_000).toISOString())
      .then(({ data }) => setAufgeraeumt((data ?? []).reduce((s, r) => s + (parseInt(r.ergebnis ?? "", 10) || 0), 0)));
  }, [version]);

  async function entscheiden(u: Unsicher, urteil: "muell" | "behalten") {
    setLaeuft(u.id);
    try {
      let rest = [u.adresse];
      // Bei «Müll» wird gleich verschoben, grosse Mengen in Portionen.
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
      setListe((l) => l.filter((x) => x.id !== u.id));
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    }
    setLaeuft(null);
  }

  if (!liste.length && !aufgeraeumt) return null;
  return (
    <Abschnitt nummer="🧹" titel="Aufräumen: Agent ist unsicher" anzahl={liste.length}>
      {aufgeraeumt > 0 && (
        <p className="text-sm text-stone-500">
          In den letzten 7 Tagen hat der Agent {aufgeraeumt.toLocaleString("de-CH")} Mails selbständig in den Papierkorb
          verschoben (30 Tage zurückholbar).
        </p>
      )}
      {liste.length > 0 && (
        <Karte>
          <div className="divide-y divide-stone-100">
            {liste.map((u) => (
              <div key={u.id} className="flex flex-wrap items-start gap-2 py-2 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1 text-sm">
                  <span className="font-medium">{u.name || u.adresse}</span>
                  {u.name && <span className="ml-1 text-xs text-stone-400">{u.adresse}</span>}
                  <span className="block truncate text-xs text-stone-500">{u.beispiele.join(" · ")}</span>
                  <span className="block text-xs text-stone-400">
                    {u.accounts?.adresse} · {u.anzahl}× in der Stichprobe{u.grund ? ` · ${u.grund}` : ""}
                  </span>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Knopf onClick={() => entscheiden(u, "muell")} disabled={laeuft === u.id}>
                    Müll
                  </Knopf>
                  <Knopf onClick={() => entscheiden(u, "behalten")} disabled={laeuft === u.id} primaer>
                    Behalten
                  </Knopf>
                </div>
              </div>
            ))}
          </div>
        </Karte>
      )}
    </Abschnitt>
  );
}
