import { einordnen, entwerfen, istZeitproblem, type Einordnung } from "./claude.js";
import { db, log, type AccountRow, type Agent, type Kategorie, type MessageRow } from "./db.js";
import { envOptional } from "./env.js";
import { providerFor } from "./providers/index.js";
import type { IncomingMail } from "./providers/types.js";

const START_TAGE = Number(envOptional("MAIL_START_TAGE") ?? 3);
const MAX_PRO_POSTFACH = Number(envOptional("MAIL_MAX_PRO_LAUF") ?? 20);
// Mails, die pro Lauf gleichzeitig eingeordnet werden. Ein Lauf hat höchstens 30 Sekunden.
const PARALLEL = Number(envOptional("MAIL_PARALLEL") ?? 4);
const ARCHIV_IM_POSTFACH = envOptional("MAIL_ARCHIV_IM_POSTFACH") === "true";

const ZUTEILUNG: Record<Kategorie, Agent> = {
  finanz: "finanz",
  service: "service",
  privat: "sven",
  unklar: "sven",
  geschäftlich: "sven",
  newsletter: "mail",
};

// ─── Schritt 1: neue Mails holen und speichern ───────────────────────────────

function mitZeitlimit<T>(p: Promise<T>, ms: number, was: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${was}: keine Antwort nach ${ms / 1000} s`)), ms)),
  ]);
}

async function abholen(account: AccountRow): Promise<number> {
  const startDatum = new Date(Date.now() - START_TAGE * 86_400_000);
  const { mails, sync } = await mitZeitlimit(
    providerFor(account).fetchNew(account, startDatum, MAX_PRO_POSTFACH),
    15_000,
    `Postfach ${account.adresse}`,
  );

  let neu = 0;
  if (mails.length > 0) {
    const { data, error } = await db()
      .from("messages")
      .upsert(
        mails.map((m) => ({
          account_id: account.id,
          extern_id: m.externId,
          message_id_header: m.messageIdHeader,
          thread_ref: m.threadRef,
          absender: m.absender,
          absender_name: m.absenderName,
          empfaenger: m.empfaenger,
          betreff: m.betreff,
          text: m.text,
          empfangen_am: m.empfangenAm.toISOString(),
        })),
        { onConflict: "account_id,extern_id", ignoreDuplicates: true },
      )
      .select("id");
    if (error) throw new Error(`Speichern fehlgeschlagen: ${error.message}`);
    neu = data?.length ?? 0;
  }

  // Stand erst nach erfolgreichem Speichern fortschreiben, sonst gingen Mails verloren.
  await db()
    .from("accounts")
    .update({ ...sync, sync_zuletzt: new Date().toISOString(), sync_fehler: null })
    .eq("id", account.id);
  return neu;
}

// ─── Schritt 2: einordnen, zuteilen, Entwürfe und Aufgaben ───────────────────

function alsMail(row: MessageRow): IncomingMail {
  return {
    externId: row.extern_id,
    messageIdHeader: row.message_id_header,
    threadRef: row.thread_ref,
    absender: row.absender,
    absenderName: row.absender_name,
    empfaenger: null,
    betreff: row.betreff,
    text: row.text ?? "",
    empfangenAm: row.empfangen_am ? new Date(row.empfangen_am) : new Date(),
  };
}

async function entwurfAnlegen(row: MessageRow, account: AccountRow, e: Einordnung, frist: number): Promise<void> {
  // Bei einem Wiederholungslauf nicht doppelt entwerfen.
  const { count } = await db()
    .from("drafts")
    .select("id", { count: "exact", head: true })
    .eq("message_id", row.id)
    .eq("status", "offen");
  if (count) return;

  const { data: wissen } = await db()
    .from("knowledge")
    .select("thema, antwort, sprache")
    .eq("marke", e.marke)
    .eq("geprueft", true);
  const entwurf = await entwerfen(alsMail(row), account, e, wissen ?? [], frist);
  const { error } = await db().from("drafts").insert({
    message_id: row.id,
    text_original: entwurf.text_original,
    text_deutsch: e.sprache === "de" ? null : entwurf.text_deutsch,
    sprache: e.sprache,
    erstellt_von: "mail",
    begruendung: entwurf.begruendung,
  });
  if (error) throw new Error(`Entwurf speichern: ${error.message}`);
  await log("mail", "entwurf_angelegt", row.id, `${e.sprache}, ${e.marke}`);
}

async function verarbeiten(row: MessageRow, account: AccountRow, frist: number): Promise<void> {
  const e = await einordnen(alsMail(row), account, frist);
  const zugewiesen = ZUTEILUNG[e.kategorie];

  await db()
    .from("messages")
    .update({
      sprache: e.sprache,
      kategorie: e.kategorie,
      marke: e.marke,
      zusammenfassung: e.zusammenfassung,
      zugewiesen_an: zugewiesen,
    })
    .eq("id", row.id);
  await log("mail", "eingeordnet", row.id, `${e.kategorie} → ${zugewiesen} (${e.marke}, ${e.sprache})`);

  if (e.kategorie === "newsletter") {
    if (ARCHIV_IM_POSTFACH) await providerFor(account).archive(account, row.extern_id);
    await db().from("messages").update({ status: "archiviert" }).eq("id", row.id);
    await log("mail", "archiviert", row.id, ARCHIV_IM_POSTFACH ? "auch im Postfach" : "nur in der Datenbank");
    return;
  }

  const brauchtEntwurf = (e.kategorie === "service" || e.kategorie === "geschäftlich") && e.antwort_noetig;
  if (brauchtEntwurf) await entwurfAnlegen(row, account, e, frist);

  // Sven-Regel: Aufgabe nur, wenn er selbst handeln muss. Ein Entwurf allein ist keine Aufgabe,
  // der erscheint ohnehin unter «Entwürfe zur Freigabe».
  if (e.sven_muss_handeln && e.aufgabe_titel) {
    await db().from("tasks").insert({
      titel: e.aufgabe_titel,
      grund: e.aufgabe_grund ?? e.zusammenfassung,
      quelle: "mail",
      message_id: row.id,
      faellig_am: /^\d{4}-\d{2}-\d{2}$/.test(e.faellig_am ?? "") ? e.faellig_am : null,
    });
    await log("mail", "aufgabe_angelegt", row.id, e.aufgabe_titel);
  }

  await db().from("messages").update({ status: "verarbeitet", fehler: null }).eq("id", row.id);
}

async function offeneVerarbeiten(accounts: Map<string, AccountRow>, frist: number): Promise<{ ok: number; fehler: number }> {
  // Hängengebliebene Läufe (Absturz, Zeitlimit) nach 20 Minuten wieder freigeben.
  await db()
    .from("messages")
    .update({ status: "neu" })
    .eq("status", "in_arbeit")
    .lt("bearbeitet_am", new Date(Date.now() - 20 * 60_000).toISOString());

  const { data: kandidaten } = await db()
    .from("messages")
    .select("id")
    .eq("status", "neu")
    .order("empfangen_am", { ascending: true })
    .limit(PARALLEL);
  if (!kandidaten?.length) return { ok: 0, fehler: 0 };

  // Beanspruchen, damit ein parallel laufender Durchgang dieselben Mails nicht doppelt bearbeitet.
  const { data: rows, error } = await db()
    .from("messages")
    .update({ status: "in_arbeit", bearbeitet_am: new Date().toISOString() })
    .eq("status", "neu")
    .in("id", kandidaten.map((k) => k.id))
    .select("*");
  if (error) throw new Error(error.message);

  let ok = 0;
  let fehler = 0;
  await Promise.all(
    ((rows ?? []) as MessageRow[]).map(async (row) => {
      const account = accounts.get(row.account_id);
      try {
        if (!account) throw new Error("Postfach inaktiv oder gelöscht");
        await verarbeiten(row, account, frist);
        ok++;
      } catch (err) {
        if (istZeitproblem(err)) {
          // Kein Fehler: im nächsten Lauf nochmals versuchen.
          await db().from("messages").update({ status: "neu" }).eq("id", row.id);
          return;
        }
        fehler++;
        const msg = err instanceof Error ? err.message : String(err);
        await db().from("messages").update({ status: "fehler", fehler: msg }).eq("id", row.id);
        await log("mail", "fehler", row.id, msg);
      }
    }),
  );
  return { ok, fehler };
}

// ─── Ein Durchlauf ───────────────────────────────────────────────────────────

/** frist: Zeitpunkt (ms), bis zu dem der Lauf fertig sein muss. */
export async function mailAgentLauf(frist: number): Promise<string> {
  const { data, error } = await db().from("accounts").select("*").eq("aktiv", true);
  if (error) throw new Error(error.message);
  const accounts = new Map((data as AccountRow[]).map((a) => [a.id, a]));

  const ergebnisse = await Promise.all(
    [...accounts.values()].map(async (account) => {
      try {
        const n = await abholen(account);
        if (n > 0) await log("mail", "abgeholt", account.adresse, `${n} neue Mails`);
        return n;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await db().from("accounts").update({ sync_fehler: msg, sync_zuletzt: new Date().toISOString() }).eq("id", account.id);
        await log("mail", "abholen_fehler", account.adresse, msg);
        return 0;
      }
    }),
  );
  const neu = ergebnisse.reduce((a, b) => a + b, 0);

  const { ok, fehler } = await offeneVerarbeiten(accounts, frist);
  return `${neu} neu, ${ok} verarbeitet, ${fehler} Fehler`;
}
