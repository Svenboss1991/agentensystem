import type { Config } from "@netlify/functions";
import { aufraeumerFuer, aufraeumSchritt } from "../lib/aufraeumen.js";
import { db, log, type AccountRow } from "../lib/db.js";

// Selbständiges Aufräumen, alle 2 Minuten ein Schritt: eine Seite einer Kategorie eines Postfachs.
// Zuerst werden Kategorien fertig durchgegangen, die noch nie ganz durch waren (alle Jahre);
// danach wird jede Kategorie einmal täglich erneut durchgegangen (neue Mails, neue Absender).

const TAG_MS = 86_400_000;

export default async () => {
  const start = Date.now();
  const { data: accounts } = await db().from("accounts").select("*").eq("aktiv", true).eq("auto_aufraeumen", true);
  const { data: staende } = await db().from("aufraeum_stand").select("account_id, kategorie, zuletzt, cursor, durchgang_fertig_am");
  const stand = new Map((staende ?? []).map((s) => [`${s.account_id}|${s.kategorie}`, s]));

  // Postfächer, die gerade von Hand aufgeräumt werden («Jetzt aufräumen»), in Ruhe lassen,
  // damit Gmail & Co. nicht wegen zu vieler Anfragen bremsen.
  const beschaeftigt = new Set(
    (staende ?? []).filter((s) => s.zuletzt && Date.now() - Date.parse(s.zuletzt) < 90_000).map((s) => s.account_id),
  );

  const kandidaten = ((accounts ?? []) as AccountRow[])
    .filter((a) => !beschaeftigt.has(a.id))
    .flatMap((a) =>
      Object.keys(aufraeumerFuer(a).kategorien).map((k) => {
        const s = stand.get(`${a.id}|${k}`);
        const fertig = s?.durchgang_fertig_am ? Date.parse(s.durchgang_fertig_am) : 0;
        return {
          account: a,
          kategorie: k,
          zuletzt: s?.zuletzt ? Date.parse(s.zuletzt) : 0,
          // Mitten im Durchgang oder nie fertig geworden → hat Vorrang; sonst erst nach einem Tag wieder.
          offen: !!s?.cursor || !fertig,
          faellig: !!s?.cursor || !fertig || Date.now() - fertig > TAG_MS,
        };
      }),
    )
    .filter((k) => k.faellig)
    .sort((x, y) => Number(y.offen) - Number(x.offen) || x.zuletzt - y.zuletzt);

  const dran = kandidaten[0];
  if (!dran) return;
  try {
    const r = await aufraeumSchritt(dran.account, dran.kategorie, start, "mail");
    console.log(`Aufräumen ${dran.account.adresse}/${dran.kategorie}: ${r.verschoben} verschoben, ${r.geprueft} geprüft`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db()
      .from("aufraeum_stand")
      .upsert({ account_id: dran.account.id, kategorie: dran.kategorie, zuletzt: new Date().toISOString(), fehler: msg });
    await log("mail", "aufraeumen_fehler", `${dran.account.adresse}/${dran.kategorie}`, msg);
  }
};

export const config: Config = { schedule: "*/2 * * * *" };
