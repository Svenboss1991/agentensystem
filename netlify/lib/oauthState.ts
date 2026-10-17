import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env.js";

// Der «state» bei OAuth trägt die Postfach-ID und ist signiert, damit niemand
// einen fremden Rückruf einem von Svens Postfächern unterschieben kann.

const signatur = (daten: string) =>
  createHmac("sha256", env("SUPABASE_SERVICE_ROLE_KEY")).update(daten).digest("base64url");

export function stateErstellen(accountId: string): string {
  const daten = Buffer.from(JSON.stringify({ a: accountId, e: Date.now() + 15 * 60_000 })).toString("base64url");
  return `${daten}.${signatur(daten)}`;
}

export function statePruefen(state: string | null): string | null {
  const [daten, sig] = state?.split(".") ?? [];
  if (!daten || !sig) return null;
  const erwartet = Buffer.from(signatur(daten));
  const erhalten = Buffer.from(sig);
  if (erwartet.length !== erhalten.length || !timingSafeEqual(erwartet, erhalten)) return null;
  const { a, e } = JSON.parse(Buffer.from(daten, "base64url").toString()) as { a: string; e: number };
  return e > Date.now() ? a : null;
}
