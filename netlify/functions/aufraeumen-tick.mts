import type { Config } from "@netlify/functions";
import { absenderVerschieben, aufraeumerFuer, neueAbsenderBewerten } from "../lib/aufraeumen.js";
import { db, log, type AccountRow } from "../lib/db.js";

// Selbständiges Aufräumen, alle 15 Minuten eine Kategorie eines Postfachs (reihum):
// neue Absender bewerten lassen, «Müll» in den Papierkorb, «unsicher» bleibt für Sven auf «Heute».
// Bekannte Müll-Absender werden bei jedem Durchgang erneut geleert (neue Werbung derselben Absender).

const LAUFZEIT_MS = 25_000;

export default async () => {
  const start = Date.now();
  const { data: accounts } = await db().from("accounts").select("*").eq("aktiv", true).eq("auto_aufraeumen", true);
  const { data: staende } = await db().from("aufraeum_stand").select("account_id, kategorie, zuletzt");
  const zuletzt = new Map((staende ?? []).map((s) => [`${s.account_id}|${s.kategorie}`, s.zuletzt ? Date.parse(s.zuletzt) : 0]));

  // Die am längsten nicht mehr aufgeräumte Kategorie kommt dran.
  const kandidaten = ((accounts ?? []) as AccountRow[]).flatMap((a) =>
    Object.keys(aufraeumerFuer(a).kategorien).map((k) => ({ account: a, kategorie: k, zuletzt: zuletzt.get(`${a.id}|${k}`) ?? 0 })),
  );
  kandidaten.sort((x, y) => x.zuletzt - y.zuletzt);
  const dran = kandidaten[0];
  if (!dran) return;
  const { account, kategorie } = dran;

  try {
    await neueAbsenderBewerten(account, kategorie, start + 18_000);
    const { data: muell } = await db()
      .from("aufraeum_absender")
      .select("adresse")
      .eq("account_id", account.id)
      .eq("kategorie", kategorie)
      .eq("urteil", "muell");
    const r = await absenderVerschieben(account, kategorie, (muell ?? []).map((m) => m.adresse as string), start + LAUFZEIT_MS, "mail");
    await db()
      .from("aufraeum_stand")
      .upsert({ account_id: account.id, kategorie, zuletzt: new Date().toISOString(), fehler: null });
    console.log(`Aufräumen ${account.adresse}/${kategorie}: ${r.verschoben} verschoben`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db().from("aufraeum_stand").upsert({ account_id: account.id, kategorie, zuletzt: new Date().toISOString(), fehler: msg });
    await log("mail", "aufraeumen_fehler", `${account.adresse}/${kategorie}`, msg);
  }
};

export const config: Config = { schedule: "*/15 * * * *" };
