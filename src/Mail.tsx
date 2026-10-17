import { useState } from "react";
import { MARKEN, zeit, type Marke } from "./lib/supabase";
import { Marker } from "./ui";

export interface Mail {
  id: string;
  richtung?: "eingehend" | "ausgehend";
  absender: string;
  absender_name: string | null;
  empfaenger?: string | null;
  betreff: string | null;
  text: string | null;
  zusammenfassung: string | null;
  kategorie: string | null;
  marke: Marke | null;
  sprache: string | null;
  empfangen_am: string | null;
  fehler?: string | null;
  akte_id?: string | null;
  kontakt_id?: string | null;
  accounts: { adresse: string } | null;
}

export const MAIL_FELDER =
  "id, richtung, absender, absender_name, empfaenger, betreff, text, zusammenfassung, kategorie, marke, sprache, empfangen_am, fehler, akte_id, kontakt_id, accounts(adresse)";

/** Kopf einer Mail mit Zusammenfassung; «Mail öffnen» zeigt den ganzen Text. */
export function MailKopf({ mail, offen: anfangsOffen = false }: { mail: Mail; offen?: boolean }) {
  const [offen, setOffen] = useState(anfangsOffen);
  const ausgehend = mail.richtung === "ausgehend";
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">
          {ausgehend && <span className="mr-1 text-stone-400">↗</span>}
          {mail.betreff || "(ohne Betreff)"}
        </p>
        <p className="text-xs text-stone-400">{zeit(mail.empfangen_am)}</p>
      </div>
      <p className="text-sm text-stone-600">
        {mail.kontakt_id ? (
          <a href={`#/kontakt/${mail.kontakt_id}`} className="underline decoration-stone-300 hover:decoration-stone-600">
            {ausgehend ? `an ${mail.empfaenger ?? "?"}` : mail.absender_name ? `${mail.absender_name} <${mail.absender}>` : mail.absender}
          </a>
        ) : ausgehend ? (
          `an ${mail.empfaenger ?? "?"}`
        ) : mail.absender_name ? (
          `${mail.absender_name} <${mail.absender}>`
        ) : (
          mail.absender
        )}
      </p>
      {mail.zusammenfassung && <p className="mt-2 text-sm">{mail.zusammenfassung}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
        {mail.kategorie && <Marker>{mail.kategorie}</Marker>}
        {mail.marke && mail.marke !== "keine" && <Marker>{MARKEN[mail.marke]}</Marker>}
        {mail.sprache && <Marker>{mail.sprache.toUpperCase()}</Marker>}
        {mail.accounts && <Marker>{mail.accounts.adresse}</Marker>}
        <button onClick={() => setOffen((o) => !o)} className="ml-1 text-stone-500 underline">
          {offen ? "Mail schliessen" : "Mail öffnen"}
        </button>
      </div>
      {offen && (
        <pre className="mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded bg-stone-100 p-3 font-sans text-sm">
          {mail.text || "(kein Text)"}
        </pre>
      )}
    </div>
  );
}
