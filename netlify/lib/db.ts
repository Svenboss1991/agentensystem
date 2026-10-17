import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.js";

export type Marke = "tamelo" | "don_sombrerito" | "clave_suiza" | "keine";
export type Agent = "mail" | "service" | "marketing" | "finanz" | "ceo" | "reise" | "sven";
export type Kategorie = "finanz" | "service" | "privat" | "geschäftlich" | "newsletter" | "unklar";
export type Sprache = "de" | "en" | "es" | "andere";

export interface AccountRow {
  id: string;
  provider: "hostpoint" | "hostinger" | "hotmail" | "gmail";
  typ: "imap" | "oauth";
  adresse: string;
  anzeigename: string | null;
  marke: Marke;
  aktiv: boolean;
  secret_ref: string;
  imap_host: string | null;
  imap_port: number | null;
  smtp_host: string | null;
  smtp_port: number | null;
  benutzer: string | null;
  archiv_ordner: string | null;
  sync_uidvalidity: number | null;
  sync_letzte_uid: number | null;
  sync_seit: string | null;
  sync_sent_uidvalidity: number | null;
  sync_sent_letzte_uid: number | null;
  sync_sent_seit: string | null;
}

export interface MessageRow {
  id: string;
  account_id: string;
  richtung: "eingehend" | "ausgehend";
  extern_id: string;
  message_id_header: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  thread_ref: string | null;
  absender: string;
  absender_name: string | null;
  empfaenger: string | null;
  betreff: string | null;
  text: string | null;
  empfangen_am: string | null;
  sprache: Sprache | null;
  kategorie: Kategorie | null;
  marke: Marke | null;
  status: string;
}

export interface DraftRow {
  id: string;
  message_id: string;
  text_original: string;
  status: string;
}

let client: SupabaseClient | undefined;

/** Service-Role-Client: nur serverseitig verwenden, umgeht RLS. */
export function db(): SupabaseClient {
  client ??= createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** Jede Agent-Aktion landet in agent_log. Ein Fehler beim Protokollieren bricht nichts ab. */
export async function log(agent: Agent, aktion: string, ziel: string | null, ergebnis: string): Promise<void> {
  const { error } = await db().from("agent_log").insert({ agent, aktion, ziel, ergebnis: ergebnis.slice(0, 2000) });
  if (error) console.error("agent_log fehlgeschlagen:", error.message);
}

export interface PendenzRow {
  id: string;
  titel: string;
  gegenpartei: string | null;
  gegenpartei_adresse: string | null;
  worauf: string | null;
  seit: string;
  wiedervorlage_am: string;
  thread_message_ids: string[];
}
