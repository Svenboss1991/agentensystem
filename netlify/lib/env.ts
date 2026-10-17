export function env(name: string): string {
  const value = process.env[name];
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
