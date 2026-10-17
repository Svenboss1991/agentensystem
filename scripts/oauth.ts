// Einmalige OAuth-Freigabe für Gmail bzw. Hotmail. Läuft lokal auf Svens Rechner:
//   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… npm run oauth -- google
//   MICROSOFT_CLIENT_ID=… npm run oauth -- microsoft
// Gibt das Refresh-Token aus. Sven trägt es als MAIL_<SECRET_REF>_REFRESH_TOKEN in Netlify ein.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/callback`;
const anbieter = process.argv[2];

const config =
  anbieter === "google"
    ? {
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scope: "https://www.googleapis.com/auth/gmail.modify",
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        extra: { access_type: "offline", prompt: "consent" } as Record<string, string>,
      }
    : anbieter === "microsoft"
      ? {
          authUrl: "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize",
          tokenUrl: "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
          scope: "offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send",
          clientId: process.env.MICROSOFT_CLIENT_ID,
          clientSecret: undefined,
          extra: { prompt: "consent" } as Record<string, string>,
        }
      : undefined;

if (!config?.clientId) {
  console.error("Aufruf: npm run oauth -- google|microsoft  (Client-ID als Umgebungsvariable setzen)");
  process.exit(1);
}

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("hex");

const url = new URL(config.authUrl);
url.search = new URLSearchParams({
  client_id: config.clientId,
  redirect_uri: REDIRECT,
  response_type: "code",
  scope: config.scope,
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
  ...config.extra,
}).toString();

const server = createServer(async (req, res) => {
  const q = new URL(req.url ?? "/", REDIRECT).searchParams;
  if (!req.url?.startsWith("/callback")) return res.end();
  if (q.get("state") !== state || !q.get("code")) {
    res.end("Fehler: ungültige Antwort.");
    return;
  }
  const body = new URLSearchParams({
    client_id: config.clientId!,
    grant_type: "authorization_code",
    code: q.get("code")!,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
    ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
  });
  const tokenRes = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const tokens = (await tokenRes.json()) as { refresh_token?: string; error_description?: string };
  if (tokens.refresh_token) {
    res.end("Fertig. Das Fenster kann geschlossen werden.");
    console.log("\nRefresh-Token (geheim halten, nur in Netlify eintragen):\n");
    console.log(tokens.refresh_token);
  } else {
    res.end("Fehler, siehe Terminal.");
    console.error("Kein Refresh-Token erhalten:", tokens.error_description ?? tokens);
  }
  server.close();
});

server.listen(PORT, () => {
  console.log("Diesen Link im Browser öffnen und mit dem richtigen Konto anmelden:\n");
  console.log(url.toString());
});
