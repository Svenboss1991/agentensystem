// Die Supabase-Werte stehen für die Seite schon als VITE_… bereit; die Funktionen dürfen sie mitbenutzen.
const ERSATZ: Record<string, string> = {
  SUPABASE_URL: "VITE_SUPABASE_URL",
  SUPABASE_ANON_KEY: "VITE_SUPABASE_ANON_KEY",
};

export function env(name: string): string {
  const value = process.env[name] || (ERSATZ[name] ? process.env[ERSATZ[name]] : undefined);
  if (!value) throw new Error(`Umgebungsvariable ${name} fehlt`);
  return value;
}

export function envOptional(name: string): string | undefined {
  return process.env[name] || undefined;
}

/** Geheimnis eines Postfachs, z. B. secretFor("HOSTPOINT_INFO", "PASSWORD") → MAIL_HOSTPOINT_INFO_PASSWORD */
export function secretFor(secretRef: string, suffix: "PASSWORD" | "REFRESH_TOKEN"): string {
  return env(`MAIL_${secretRef.toUpperCase()}_${suffix}`);
}
