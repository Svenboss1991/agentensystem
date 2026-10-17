import { db, log, type AccountRow } from "../lib/db.js";
import { statePruefen } from "../lib/oauthState.js";
import { anbieterFuer, redirectUri, refreshTokenSpeichern, tokenAnfrage } from "../lib/providers/oauth.js";

const zurueck = (params: Record<string, string>) =>
  new Response(null, { status: 302, headers: { location: `/?${new URLSearchParams(params)}` } });

/** Google/Microsoft leiten nach der Freigabe hierher zurück. */
async function angemeldeteAdresse(anbieter: "google" | "microsoft", accessToken: string): Promise<string | null> {
  const headers = { authorization: `Bearer ${accessToken}` };
  if (anbieter === "google") {
    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers });
    return r.ok ? ((await r.json()) as { emailAddress?: string }).emailAddress ?? null : null;
  }
  const r = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", { headers });
  if (!r.ok) return null;
  const me = (await r.json()) as { mail?: string; userPrincipalName?: string };
  return me.mail ?? me.userPrincipalName ?? null;
}

export default async (req: Request) => {
  const q = new URL(req.url).searchParams;
  if (q.get("error")) return zurueck({ oauth_fehler: q.get("error_description") ?? q.get("error")! });

  const accountId = statePruefen(q.get("state"));
  const code = q.get("code");
  if (!accountId || !code) return zurueck({ oauth_fehler: "Ungültige oder abgelaufene Anfrage, bitte nochmals verbinden" });

  const { data: account } = await db().from("accounts").select("*").eq("id", accountId).single<AccountRow>();
  if (!account) return zurueck({ oauth_fehler: "Postfach nicht gefunden" });

  try {
    const anbieter = anbieterFuer(account);
    const tokens = await tokenAnfrage(anbieter, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
    });
    if (!tokens.refresh_token || !tokens.access_token) throw new Error("Kein Refresh-Token erhalten");

    const adresse = await angemeldeteAdresse(anbieter, tokens.access_token);
    if (adresse && adresse.toLowerCase() !== account.adresse.toLowerCase()) {
      throw new Error(`Angemeldet als ${adresse}, erwartet war ${account.adresse}. Bitte mit dem richtigen Konto anmelden.`);
    }

    await refreshTokenSpeichern(account.id, tokens.refresh_token);
    await db().from("accounts").update({ aktiv: true, sync_fehler: null }).eq("id", account.id);
    await log("sven", "postfach_verbunden", account.adresse, anbieter);
    return zurueck({ verbunden: account.adresse });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log("sven", "verbinden_fehler", account.adresse, msg);
    return zurueck({ oauth_fehler: msg });
  }
};
