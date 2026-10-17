import { timingSafeEqual } from "node:crypto";
import { log } from "../lib/db.js";
import { mailAgentLauf } from "../lib/mailAgent.js";

function secretOk(given: string | null): boolean {
  const expected = process.env.AGENT_SECRET ?? "";
  if (!given || !expected || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export default async (req: Request) => {
  if (!secretOk(req.headers.get("x-agent-secret"))) return new Response("Nicht erlaubt", { status: 401 });
  try {
    const ergebnis = await mailAgentLauf();
    console.log("Mail-Agent:", ergebnis);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Mail-Agent abgebrochen:", msg);
    await log("mail", "lauf_abgebrochen", null, msg);
  }
};
