import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);

export const ZEITZONE = "America/Bahia_Banderas";

export type Marke = "tamelo" | "don_sombrerito" | "clave_suiza" | "keine";

export const MARKEN: Record<Marke, string> = {
  tamelo: "Tamelo",
  don_sombrerito: "Don Sombrerito",
  clave_suiza: "Clave Suiza",
  keine: "–",
};

export const zeit = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("de-CH", { timeZone: ZEITZONE, dateStyle: "short", timeStyle: "short" }).format(new Date(iso))
    : "";

/** Beginn eines Kalendertags in Svens Zeitzone als UTC-Zeitpunkt. tageZurueck = 1 → gestern. */
export function tagesbeginn(tageZurueck: number): Date {
  const teile = new Intl.DateTimeFormat("en-CA", { timeZone: ZEITZONE, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(Date.now() - tageZurueck * 86_400_000));
  const mitternachtUtc = new Date(`${teile}T00:00:00Z`);
  // Versatz der Zeitzone zu diesem Zeitpunkt bestimmen.
  const lokal = new Date(mitternachtUtc.toLocaleString("en-US", { timeZone: ZEITZONE }));
  const utc = new Date(mitternachtUtc.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(mitternachtUtc.getTime() + (utc.getTime() - lokal.getTime()));
}

export async function entwurfSenden(draftId: string, text: string): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const res = await fetch("/.netlify/functions/send-draft", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${data.session?.access_token}` },
    body: JSON.stringify({ draft_id: draftId, text }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { fehler?: string };
    throw new Error(body.fehler ?? `Senden fehlgeschlagen (${res.status})`);
  }
}

/** Startet sofort einen Durchlauf des Mail-Agenten. Gibt eine kurze Zusammenfassung zurück. */
export async function mailsAbrufen(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const res = await fetch("/.netlify/functions/mail-agent-run", {
    method: "POST",
    headers: { authorization: `Bearer ${data.session?.access_token}` },
  });
  const body = (await res.json().catch(() => ({}))) as { ergebnis?: string; fehler?: string };
  if (!res.ok) throw new Error(body.fehler ?? `Abrufen fehlgeschlagen (${res.status})`);
  return body.ergebnis ?? "";
}

/** Liefert die Anmeldeseite von Google/Microsoft, um ein Gmail-/Hotmail-Postfach zu verbinden. */
export async function oauthStarten(accountId: string): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const res = await fetch("/.netlify/functions/oauth-start", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${data.session?.access_token}` },
    body: JSON.stringify({ account_id: accountId }),
  });
  const body = (await res.json().catch(() => ({}))) as { url?: string; fehler?: string };
  if (!res.ok || !body.url) throw new Error(body.fehler ?? `Verbinden fehlgeschlagen (${res.status})`);
  return body.url;
}
