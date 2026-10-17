import { json, nichtSven } from "../lib/auth.js";
import { db, type AccountRow } from "../lib/db.js";
import { stateErstellen } from "../lib/oauthState.js";
import { anbieterFuer, OAUTH, redirectUri } from "../lib/providers/oauth.js";

/** Knopf «Verbinden» bei Gmail/Hotmail: liefert die Anmeldeseite von Google bzw. Microsoft. */
export default async (req: Request) => {
  if (req.method !== "POST") return json(405, { fehler: "Nur POST" });
  const verweigert = await nichtSven(req);
  if (verweigert) return json(403, { fehler: `Nicht erlaubt: ${verweigert}` });

  const { account_id } = (await req.json().catch(() => ({}))) as { account_id?: string };
  const { data: account } = await db().from("accounts").select("*").eq("id", account_id ?? "").maybeSingle<AccountRow>();
  if (!account || account.typ !== "oauth") return json(400, { fehler: "Unbekanntes Postfach" });

  try {
    const c = OAUTH[anbieterFuer(account)];
    const url = new URL(c.authUrl);
    url.search = new URLSearchParams({
      client_id: c.clientId(),
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: c.scope,
      state: stateErstellen(account.id),
      login_hint: account.adresse,
      ...c.extra,
    }).toString();
    return json(200, { url: url.toString() });
  } catch (err) {
    return json(500, { fehler: err instanceof Error ? err.message : String(err) });
  }
};
