// Die Supabase-Adresse und der öffentliche Schlüssel stehen für die Seite als VITE_… bereit
// und funktionieren dort nachweislich. Die Funktionen nehmen zuerst diese Werte.
const ZUERST: Record<string, string> = {
  SUPABASE_URL: "VITE_SUPABASE_URL",
  SUPABASE_ANON_KEY: "VITE_SUPABASE_ANON_KEY",
};

function lesen(name: string): string | undefined {
  const value = (ZUERST[name] && process.env[ZUERST[name]]?.trim()) || process.env[name]?.trim();
  return value || undefined;
}

export function env(name: string): string {
  const value = lesen(name);
  if (!value) throw new Error(`Umgebungsvariable ${name} fehlt`);
  return value;
}

export function envOptional(name: string): string | undefined {
  return lesen(name);
}

/** Geheimnis eines Postfachs, z. B. secretFor("HOSTPOINT_INFO", "PASSWORD") → MAIL_HOSTPOINT_INFO_PASSWORD */
export function secretFor(secretRef: string, suffix: "PASSWORD" | "REFRESH_TOKEN"): string {
  return env(`MAIL_${secretRef.toUpperCase()}_${suffix}`);
}
