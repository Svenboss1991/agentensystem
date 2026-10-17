import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

/** Prüft, ob die Anfrage von Svens angemeldeter Sitzung kommt (Supabase-Login + Eintrag in app_owner). */
export async function kommtVonSven(req: Request): Promise<boolean> {
  const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!jwt) return false;
  const asUser = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    global: { headers: { authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
  const { data } = await asUser.rpc("ist_sven");
  return data === true;
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
