import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

/**
 * Prüft, ob die Anfrage von Svens angemeldeter Sitzung kommt (Supabase-Login + Eintrag in app_owner).
 * Gibt null zurück, wenn ja, sonst den Grund.
 */
export async function nichtSven(req: Request): Promise<string | null> {
  const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!jwt) return "Nicht angemeldet";
  try {
    const asUser = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
      global: { headers: { authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false },
    });
    const { data, error } = await asUser.rpc("ist_sven");
    if (error) return `Supabase-Prüfung fehlgeschlagen: ${error.message}`;
    return data === true ? null : "Nicht als Besitzer eingetragen";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
