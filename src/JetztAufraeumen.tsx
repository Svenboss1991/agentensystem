import { useState } from "react";
import { funktion } from "./lib/supabase";
import { Knopf } from "./ui";

interface Schritt {
  titel?: string;
  geprueft?: number;
  verschoben: number;
  unsicher: number;
  weiter: number | null;
}

/** Ein Klick: der Agent räumt alle Kategorien des Postfachs auf und fragt nur bei unsicheren Absendern (auf «Heute»). */
export default function JetztAufraeumen({ accountId, fertig }: { accountId: string; fertig: () => void }) {
  const [laeuft, setLaeuft] = useState(false);
  const [meldung, setMeldung] = useState("");

  async function starten() {
    setLaeuft(true);
    let index: number | null = 0;
    let verschoben = 0;
    let unsicher = 0;
    let fehlversuche = 0;
    while (index !== null) {
      try {
        const r: Schritt = await funktion<Schritt>("aufraeumen", { aktion: "schritt", account_id: accountId, index });
        verschoben += r.verschoben;
        unsicher += r.unsicher;
        index = r.weiter;
        fehlversuche = 0;
        setMeldung(
          `${r.titel ?? ""}: ${(r.geprueft ?? 0).toLocaleString("de-CH")} Mails geprüft · insgesamt ${verschoben.toLocaleString("de-CH")} in den Papierkorb …`,
        );
      } catch (e) {
        // Zeitüberschreitung o. Ä.: nochmals versuchen, nach drei Fehlern aufhören.
        if (++fehlversuche >= 3) {
          setMeldung(e instanceof Error ? e.message : String(e));
          setLaeuft(false);
          return;
        }
      }
    }
    setMeldung(
      `Fertig: ${verschoben.toLocaleString("de-CH")} Mails in den Papierkorb.` +
        (unsicher ? ` ${unsicher} Absender unsicher, siehe «Aufräumen: Agent ist unsicher» oben.` : ""),
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
