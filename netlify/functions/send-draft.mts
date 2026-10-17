import { createClient } from "@supabase/supabase-js";
import { db, log, type AccountRow, type MessageRow } from "../lib/db.js";
import { env } from "../lib/env.js";
import { providerFor } from "../lib/providers/index.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Versendet einen Entwurf, den Sven auf der Seite «Heute» freigegeben hat.
 * Agenten rufen das nie auf; nur Svens angemeldete Sitzung darf senden.
 */
export default async (req: Request) => {
  if (req.method !== "POST") return json(405, { fehler: "Nur POST" });

  const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!jwt) return json(401, { fehler: "Nicht angemeldet" });
  const asUser = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    global: { headers: { authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
  const { data: istSven } = await asUser.rpc("ist_sven");
  if (istSven !== true) return json(403, { fehler: "Nur Sven darf senden" });

  const { draft_id, text } = (await req.json().catch(() => ({}))) as { draft_id?: string; text?: string };
  if (!draft_id) return json(400, { fehler: "draft_id fehlt" });

  // Atomar beanspruchen: verhindert doppeltes Senden bei Doppelklick.
  const update: Record<string, unknown> = { status: "freigegeben", freigegeben_am: new Date().toISOString(), fehler: null };
  if (typeof text === "string" && text.trim()) update.text_original = text.trim();
  const { data: draft } = await db()
    .from("drafts")
    .update(update)
    .eq("id", draft_id)
    .in("status", ["offen", "fehler"])
    .select("id, message_id, text_original")
    .maybeSingle();
  if (!draft) return json(409, { fehler: "Entwurf ist nicht mehr offen" });

  const { data: message } = await db().from("messages").select("*").eq("id", draft.message_id).single<MessageRow>();
  const { data: account } = await db().from("accounts").select("*").eq("id", message!.account_id).single<AccountRow>();

  try {
    await providerFor(account!).sendReply(account!, message!, draft.text_original);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db().from("drafts").update({ status: "fehler", fehler: msg }).eq("id", draft.id);
    await log("sven", "senden_fehler", draft.id, msg);
    return json(502, { fehler: msg });
  }

  const jetzt = new Date().toISOString();
  await db().from("drafts").update({ status: "gesendet", gesendet_am: jetzt }).eq("id", draft.id);
  await db().from("messages").update({ status: "erledigt" }).eq("id", message!.id);
  await db().from("messages").insert({
    account_id: account!.id,
    richtung: "ausgehend",
    extern_id: `gesendet:${draft.id}`,
    absender: account!.adresse,
    empfaenger: message!.absender,
    betreff: message!.betreff,
    text: draft.text_original,
    empfangen_am: jetzt,
    sprache: message!.sprache,
    kategorie: message!.kategorie,
    marke: message!.marke,
    status: "erledigt",
  });
  await log("sven", "gesendet", draft.id, `an ${message!.absender}`);
  return json(200, { ok: true });
};
