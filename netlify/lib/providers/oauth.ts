import { env } from "../env.js";

const cache = new Map<string, { token: string; gueltigBis: number }>();

/** Holt ein Access-Token mit dem Refresh-Token aus der Umgebung (OAuth-Freigabe macht Sven einmalig). */
export async function accessToken(
  key: string,
  tokenUrl: string,
  params: Record<string, string>,
): Promise<string> {
  const hit = cache.get(key);
  if (hit && hit.gueltigBis > Date.now() + 60_000) return hit.token;
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", ...params }),
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`OAuth-Token für ${key} abgelehnt: ${body.error_description ?? body.error ?? res.status}`);
  }
  cache.set(key, { token: body.access_token, gueltigBis: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

export const googleClient = () => ({ client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET") });
export const microsoftClient = () => ({ client_id: env("MICROSOFT_CLIENT_ID") });

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
// «consumers» = private Microsoft-Konten (hotmail.com, outlook.com, live.com)
export const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
export const GOOGLE_SCOPES = "https://www.googleapis.com/auth/gmail.modify";
export const MICROSOFT_SCOPES = "offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send";
