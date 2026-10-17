import type { Config } from "@netlify/functions";

// Geplante Funktionen dürfen nur kurz laufen. Darum stösst der Takt nur die
// Hintergrundfunktion an, die bis zu 15 Minuten arbeiten darf.
export default async () => {
  const base = process.env.URL;
  const secret = process.env.AGENT_SECRET;
  if (!base || !secret) {
    console.error("URL oder AGENT_SECRET fehlt");
    return;
  }
  const res = await fetch(`${base}/.netlify/functions/mail-agent-background`, {
    method: "POST",
    headers: { "x-agent-secret": secret },
  });
  console.log("Mail-Agent angestossen:", res.status);
};

export const config: Config = { schedule: "*/5 * * * *" };
