import type { AccountRow } from "../db.js";
import { db } from "../db.js";
import { env, envOptional } from "../env.js";

export type OAuthAnbieter = "google" | "microsoft";

export const OAUTH = {
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email https://www.googleapis.com/auth/gmail.modify",
    extra: { access_type: "offline", prompt: "consent" } as Record<string, string>,
    clientId: () => env("GOOGLE_CLIENT_ID"),
    clientSecret: () => env("GOOGLE_CLIENT_SECRET"),
  },
  microsoft: {
    // «consumers» = private Microsoft-Konten (hotmail.com, outlook.com, live.com)
    authUrl: "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
    scope: "offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send",
    extra: { prompt: "select_account" } as Record<string, string>,
    clientId: () => env("MICROSOFT_CLIENT_ID"),
    clientSecret: () => env("MICROSOFT_CLIENT_SECRET"),
  },
} as const;

export const anbieterFuer = (account: AccountRow): OAuthAnbieter =>
  account.provider === "gmail" ? "google" : "microsoft";

export const redirectUri = () => `${env("URL")}/.netlify/functions/oauth-callback`;

interface TokenAntwort {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export async function tokenAnfrage(anbieter: OAuthAnbieter, params: Record<string, string>): Promise<TokenAntwort> {
  const c = OAUTH[anbieter];
  const res = await fetch(c.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId(), client_secret: c.clientSecret(), ...params }),
  });
  const body = (await res.json()) as TokenAntwort;
  if (!res.ok) throw new Error(`OAuth ${anbieter}: ${body.error_description ?? body.error ?? res.status}`);
  return body;
}

export async function refreshTokenSpeichern(accountId: string, refreshToken: string): Promise<void> {
  const { error } = await db()
    .from("oauth_tokens")
    .upsert({ account_id: accountId, refresh_token: refreshToken, aktualisiert_am: new Date().toISOString() });
  if (error) throw new Error(`Token speichern: ${error.message}`);
}

const cache = new Map<string, { token: string; gueltigBis: number }>();

/** Access-Token für ein Gmail-/Hotmail-Postfach. Neue Refresh-Tokens werden sofort gespeichert. */
export async function accessToken(account: AccountRow): Promise<string> {
  const hit = cache.get(account.id);
  if (hit && hit.gueltigBis > Date.now() + 60_000) return hit.token;

  const { data } = await db().from("oauth_tokens").select("refresh_token").eq("account_id", account.id).maybeSingle();
  const refresh = data?.refresh_token ?? envOptional(`MAIL_${account.secret_ref.toUpperCase()}_REFRESH_TOKEN`);
  if (!refresh) throw new Error("Postfach noch nicht verbunden (auf der Seite «Heute» auf «Verbinden» klicken)");

  const anbieter = anbieterFuer(account);
  const body = await tokenAnfrage(anbieter, {
    grant_type: "refresh_token",
    refresh_token: refresh,
    ...(anbieter === "microsoft" ? { scope: OAUTH.microsoft.scope } : {}),
  });
  if (!body.access_token) throw new Error(`OAuth ${anbieter}: kein Access-Token erhalten`);
  if (body.refresh_token && body.refresh_token !== refresh) await refreshTokenSpeichern(account.id, body.refresh_token);
  cache.set(account.id, { token: body.access_token, gueltigBis: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}
