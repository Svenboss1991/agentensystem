import { useState } from "react";
import { funktion } from "./lib/supabase";
import { Knopf } from "./ui";

interface Schritt {
  titel?: string;
  geprueft?: number;
  verschoben: number;
  muell?: number;
  behalten?: number;
  unsicher: number;
  vorgelegt?: number;
  weiter: number | null;
}

/** Ein Klick: der Agent räumt alle Kategorien des Postfachs auf und legt die übrigen Mails auf «Heute» vor. */
export default function JetztAufraeumen({ accountId, fertig }: { accountId: string; fertig: () => void }) {
  const [laeuft, setLaeuft] = useState(false);
  const [meldung, setMeldung] = useState("");

  async function starten() {
    setLaeuft(true);
    let index: number | null = 0;
    let verschoben = 0;
    let unsicher = 0;
    let muell = 0;
    let behalten = 0;
    let geprueft = 0;
    let vorgelegt = 0;
    let fehlversuche = 0;
    while (index !== null) {
      try {
        const r: Schritt = await funktion<Schritt>("aufraeumen", { aktion: "schritt", account_id: accountId, index });
        verschoben += r.verschoben;
        unsicher += r.unsicher;
        vorgelegt += r.vorgelegt ?? 0;
        muell += r.muell ?? 0;
        behalten += r.behalten ?? 0;
        if (r.weiter !== index) geprueft += r.geprueft ?? 0; // Kategorie fertig: ihre Zahl übernehmen
        index = r.weiter;
        fehlversuche = 0;
        setMeldung(
          `${r.titel ?? ""}: ${(r.geprueft ?? 0).toLocaleString("de-CH")} Mails geprüft · insgesamt ${verschoben.toLocaleString("de-CH")} in den Papierkorb …`,
        );
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        // Zeitüberschreitung oder Google bremst: kurz warten und weitermachen, nach mehreren Fehlern aufhören.
        if (++fehlversuche >= 6) {
          setMeldung(text);
          setLaeuft(false);
          return;
        }
        setMeldung(`${text} – warte kurz und mache dann weiter …`);
        await new Promise((r) => setTimeout(r, 30_000));
      }
      // Kleine Pause zwischen den Schritten, damit Gmail nicht bremst.
      await new Promise((r) => setTimeout(r, 2_000));
    }
    setMeldung(
      `Fertig: ${geprueft.toLocaleString("de-CH")} Mails geprüft, ${verschoben.toLocaleString("de-CH")} in den Papierkorb. ` +
        `Neu beurteilte Absender: ${muell} Müll, ${behalten} behalten, ${unsicher} unsicher. ` +
        (vorgelegt ? `${vorgelegt.toLocaleString("de-CH")} Mails liegen dir unter «Aufräumen: Mails prüfen» vor.` : ""),
    );
    setLaeuft(false);
    fertig();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Knopf onClick={starten} disabled={laeuft}>
        {laeuft ? "Räumt auf …" : "Jetzt aufräumen"}
      </Knopf>
      {meldung && <p className="max-w-xs text-right text-xs text-stone-500">{meldung}</p>}
      {laeuft && (
        <p className="max-w-xs text-right text-xs text-stone-400">
          Geht durch alle Jahre, das kann dauern. Schliesst du die Seite, macht der Agent automatisch weiter.
        </p>
      )}
    </div>
  );
}
