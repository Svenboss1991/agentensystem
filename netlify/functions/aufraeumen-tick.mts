import type { Config } from "@netlify/functions";
import { aufraeumerFuer, aufraeumSchritt, istWoche } from "../lib/aufraeumen.js";
import { db, log, type AccountRow } from "../lib/db.js";

// Selbständiges Aufräumen, je ein Schritt (eine Seite einer Kategorie) alle 2 Minuten, solange es etwas zu tun gibt:
// 1. Grosser Durchgang: jede Kategorie einmal durch alle Jahre.
// 2. Danach jeden Montag ab 8:00 (Svens Zeit) die Mails der letzten Woche («…_woche»-Kategorien).
// Ist nichts fällig, endet der Aufruf sofort ohne Anfrage an ein Postfach.

const ZEITZONE = "America/Bahia_Banderas";

/** Letzter Montag 08:00 in Svens Zeitzone als Zeitpunkt (ms). */
export function letzterMontagAcht(jetzt = new Date()): number {
  const teile = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: ZEITZONE,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(jetzt)
      .map((p) => [p.type, p.value]),
  );
  const wochentag = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(teile.weekday);
  let tageZurueck = wochentag;
  if (wochentag === 0 && Number(teile.hour) < 8) tageZurueck = 7;
  // Lokales Datum dieses Montags, dann Versatz der Zeitzone zu UTC bestimmen.
  const lokal = new Date(Date.UTC(Number(teile.year), Number(teile.month) - 1, Number(teile.day) - tageZurueck, 8));
  const versatz =
    Date.parse(new Date(lokal).toLocaleString("en-US", { timeZone: "UTC" })) -
    Date.parse(new Date(lokal).toLocaleString("en-US", { timeZone: ZEITZONE }));
  return lokal.getTime() + versatz;
}

export default async () => {
  const start = Date.now();
  const { data: accounts } = await db().from("accounts").select("*").eq("aktiv", true).eq("auto_aufraeumen", true);
  const { data: staende } = await db().from("aufraeum_stand").select("account_id, kategorie, zuletzt, cursor, durchgang_fertig_am");
  const stand = new Map((staende ?? []).map((s) => [`${s.account_id}|${s.kategorie}`, s]));
  const montag = letzterMontagAcht();

  // Postfächer, die gerade von Hand aufgeräumt werden («Jetzt aufräumen»), in Ruhe lassen.
  const beschaeftigt = new Set(
    (staende ?? []).filter((s) => s.zuletzt && Date.now() - Date.parse(s.zuletzt) < 90_000).map((s) => s.account_id),
  );

  const kandidaten = ((accounts ?? []) as AccountRow[])
    .filter((a) => !beschaeftigt.has(a.id))
    .flatMap((a) => {
      const keys = Object.keys(aufraeumerFuer(a).kategorien);
      const fertigAm = (k: string) => {
        const s = stand.get(`${a.id}|${k}`);
        return s?.durchgang_fertig_am ? Date.parse(s.durchgang_fertig_am) : 0;
      };
      const grossputzFertig = keys.filter((k) => !istWoche(k)).every((k) => fertigAm(k) > 0);
      return keys
        .filter((k) => {
          const s = stand.get(`${a.id}|${k}`);
          if (!istWoche(k)) return !fertigAm(k) || !!s?.cursor; // grosser Durchgang noch nicht ganz fertig
          return grossputzFertig && (fertigAm(k) < montag || !!s?.cursor); // diese Woche noch nicht aufgeräumt
        })
        .map((k) => ({ account: a, kategorie: k, zuletzt: Date.parse(stand.get(`${a.id}|${k}`)?.zuletzt ?? "1970-01-01") }));
    })
    .sort((x, y) => x.zuletzt - y.zuletzt);

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
