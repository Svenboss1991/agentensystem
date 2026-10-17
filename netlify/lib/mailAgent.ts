import { ausgangPruefen, einordnen, entwerfen, istZeitproblem, type Einordnung, type PendenzKurz } from "./claude.js";
import { db, log, type AccountRow, type Agent, type Kategorie, type MessageRow, type PendenzRow } from "./db.js";
import { envOptional } from "./env.js";
import { providerFor } from "./providers/index.js";
import type { FetchResult, IncomingMail } from "./providers/types.js";

const START_TAGE = Number(envOptional("MAIL_START_TAGE") ?? 3);
// Gesendete Mails beim ersten Mal weiter zurück lesen, damit laufende Anfragen als Pendenz auftauchen.
const START_TAGE_GESENDET = Number(envOptional("MAIL_START_TAGE_GESENDET") ?? 14);
const MAX_PRO_POSTFACH = Number(envOptional("MAIL_MAX_PRO_LAUF") ?? 20);
// Mails, die pro Lauf gleichzeitig eingeordnet werden. Ein Lauf hat höchstens 30 Sekunden.
const PARALLEL = Number(envOptional("MAIL_PARALLEL") ?? 4);
const ARCHIV_IM_POSTFACH = envOptional("MAIL_ARCHIV_IM_POSTFACH") === "true";
const ZEITZONE = "America/Bahia_Banderas";

const ZUTEILUNG: Record<Kategorie, Agent> = {
  finanz: "finanz",
  service: "service",
  privat: "sven",
  unklar: "sven",
  geschäftlich: "sven",
  newsletter: "mail",
};

/** Heutiges Datum in Svens Zeitzone, YYYY-MM-DD. */
const heute = () => new Intl.DateTimeFormat("en-CA", { timeZone: ZEITZONE }).format(new Date());
const istDatum = (s: string | null | undefined): s is string => /^\d{4}-\d{2}-\d{2}$/.test(s ?? "");

// ─── Schritt 1: neue Mails holen und speichern ───────────────────────────────

function mitZeitlimit<T>(p: Promise<T>, ms: number, was: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${was}: keine Antwort nach ${ms / 1000} s`)), ms)),
  ]);
}

async function speichern(account: AccountRow, mails: IncomingMail[], richtung: "eingehend" | "ausgehend"): Promise<number> {
  if (mails.length === 0) return 0;
  const { data, error } = await db()
    .from("messages")
    .upsert(
      mails.map((m) => ({
        account_id: account.id,
        richtung,
        extern_id: m.externId,
        message_id_header: m.messageIdHeader,
        in_reply_to: m.inReplyTo,
        references_header: m.references,
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
  return data?.length ?? 0;
}

async function abholen(account: AccountRow): Promise<number> {
  const provider = providerFor(account);
  const tageZurueck = (t: number) => new Date(Date.now() - t * 86_400_000);

  const eingang = await mitZeitlimit(
    provider.fetchNew(account, tageZurueck(START_TAGE), MAX_PRO_POSTFACH),
    15_000,
    `Postfach ${account.adresse}`,
  );
  const neu = await speichern(account, eingang.mails, "eingehend");

  // Gesendete Mails sind für Pendenzen da. Ein Fehler hier soll den Posteingang nicht blockieren.
  let gesendet: FetchResult = { mails: [], sync: {} };
  try {
    gesendet = await mitZeitlimit(
      provider.fetchSent(account, tageZurueck(START_TAGE_GESENDET), MAX_PRO_POSTFACH),
      10_000,
      `Gesendet ${account.adresse}`,
    );
    await speichern(account, gesendet.mails, "ausgehend");
  } catch (err) {
    gesendet = { mails: [], sync: {} };
    await log("mail", "gesendet_fehler", account.adresse, err instanceof Error ? err.message : String(err));
  }

  // Stand erst nach erfolgreichem Speichern fortschreiben, sonst gingen Mails verloren.
  await db()
    .from("accounts")
    .update({ ...eingang.sync, ...gesendet.sync, sync_zuletzt: new Date().toISOString(), sync_fehler: null })
    .eq("id", account.id);
  return neu;
}

// ─── Schritt 2: einordnen, zuteilen, Entwürfe, Aufgaben, Pendenzen ───────────

function alsMail(row: MessageRow): IncomingMail {
  return {
    externId: row.extern_id,
    messageIdHeader: row.message_id_header,
    inReplyTo: row.in_reply_to,
    references: row.references_header,
    threadRef: row.thread_ref,
    absender: row.absender,
    absenderName: row.absender_name,
    empfaenger: row.empfaenger,
    betreff: row.betreff,
    text: row.text ?? "",
    empfangenAm: row.empfangen_am ? new Date(row.empfangen_am) : new Date(),
  };
}

const ersteAdresse = (s: string | null) => s?.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0]?.toLowerCase() ?? null;

/** Message-IDs, auf die sich eine Mail bezieht (In-Reply-To und References). */
const fadenIds = (row: MessageRow) =>
  [row.in_reply_to, ...(row.references_header?.split(/\s+/) ?? [])].filter((x): x is string => !!x);

async function offenePendenzen(): Promise<PendenzRow[]> {
  const { data } = await db()
    .from("pendenzen")
    .select("id, titel, gegenpartei, gegenpartei_adresse, worauf, seit, wiedervorlage_am, thread_message_ids")
    .eq("status", "offen")
    .order("erstellt_am", { ascending: false })
    .limit(30);
  return (data ?? []) as PendenzRow[];
}

/** Pendenz im selben Mail-Faden, falls vorhanden. */
const imFaden = (pendenzen: PendenzRow[], row: MessageRow) => {
  const ids = fadenIds(row);
  return pendenzen.find((p) => p.thread_message_ids.some((t) => ids.includes(t)));
};

async function nachfassAufgabenSchliessen(pendenzId: string): Promise<void> {
  await db()
    .from("tasks")
    .update({ status: "erledigt", erledigt_am: new Date().toISOString() })
    .eq("pendenz_id", pendenzId)
    .eq("status", "offen");
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

async function eingangVerarbeiten(row: MessageRow, account: AccountRow, frist: number): Promise<void> {
  const pendenzen = await offenePendenzen();
  const faden = imFaden(pendenzen, row);
  const kandidaten: PendenzKurz[] = pendenzen.map((p) => ({
    ...p,
    titel: p.id === faden?.id ? `${p.titel} (gleicher Mail-Faden)` : p.titel,
  }));

  const e = await einordnen(alsMail(row), account, kandidaten, heute(), frist);
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

  if (e.pendenz_erledigt_id) {
    await db()
      .from("pendenzen")
      .update({ status: "erledigt", erledigt_am: new Date().toISOString(), antwort_message_id: row.id })
      .eq("id", e.pendenz_erledigt_id)
      .eq("status", "offen");
    await nachfassAufgabenSchliessen(e.pendenz_erledigt_id);
    await log("mail", "pendenz_erledigt", e.pendenz_erledigt_id, `Antwort von ${row.absender}`);
  }

  if (e.neue_pendenz && istDatum(e.neue_pendenz.wiedervorlage_am)) {
    await db().from("pendenzen").insert({
      titel: e.neue_pendenz.titel,
      gegenpartei: e.neue_pendenz.gegenpartei,
      gegenpartei_adresse: row.absender.toLowerCase(),
      worauf: e.neue_pendenz.worauf,
      wiedervorlage_am: e.neue_pendenz.wiedervorlage_am,
      message_id: row.id,
      thread_message_ids: [row.message_id_header, ...fadenIds(row)].filter(Boolean),
    });
    await log("mail", "pendenz_angelegt", row.id, `${e.neue_pendenz.titel} bis ${e.neue_pendenz.wiedervorlage_am}`);
  }

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
      faellig_am: istDatum(e.faellig_am) ? e.faellig_am : null,
    });
    await log("mail", "aufgabe_angelegt", row.id, e.aufgabe_titel);
  }

  await db().from("messages").update({ status: "verarbeitet", fehler: null }).eq("id", row.id);
}

async function ausgangVerarbeiten(row: MessageRow, account: AccountRow, frist: number): Promise<void> {
  const pendenzen = await offenePendenzen();
  const faden = imFaden(pendenzen, row);
  const a = await ausgangPruefen(alsMail(row), account, heute(), frist);

  if (faden) {
    // Sven hat im selben Faden nachgefasst: Pendenz weiterführen statt verdoppeln.
    await db()
      .from("pendenzen")
      .update({
        thread_message_ids: [...faden.thread_message_ids, row.message_id_header].filter(Boolean),
        wiedervorlage_am: a.wartet_auf_antwort && istDatum(a.wiedervorlage_am) ? a.wiedervorlage_am : faden.wiedervorlage_am,
        erinnert_am: null,
      })
      .eq("id", faden.id);
    await nachfassAufgabenSchliessen(faden.id);
    await log("mail", "pendenz_nachgefasst", faden.id, row.betreff ?? "");
  } else if (a.wartet_auf_antwort && a.titel && istDatum(a.wiedervorlage_am)) {
    await db().from("pendenzen").insert({
      titel: a.titel,
      gegenpartei: a.gegenpartei,
      gegenpartei_adresse: ersteAdresse(row.empfaenger),
      worauf: a.worauf,
      seit: row.empfangen_am?.slice(0, 10) ?? heute(),
      wiedervorlage_am: a.wiedervorlage_am,
      message_id: row.id,
      thread_message_ids: [row.message_id_header, ...fadenIds(row)].filter(Boolean),
    });
    await log("mail", "pendenz_angelegt", row.id, `${a.titel} bis ${a.wiedervorlage_am}`);
  }

  await db().from("messages").update({ status: "verarbeitet", fehler: null }).eq("id", row.id);
}

async function offeneVerarbeiten(
  accounts: Map<string, AccountRow>,
  frist: number,
): Promise<{ ok: number; fehler: number }> {
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
        if (row.richtung === "ausgehend") await ausgangVerarbeiten(row, account, frist);
        else await eingangVerarbeiten(row, account, frist);
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

// ─── Schritt 3: fällige Pendenzen → Nachfass-Aufgabe ─────────────────────────

/** Sven-Regel: Solange er nur wartet, keine Erinnerung. Erst wenn die Wiedervorlage erreicht ist, muss er handeln. */
async function faelligePendenzen(): Promise<number> {
  const { data } = await db()
    .from("pendenzen")
    .select("id, titel, gegenpartei, worauf, seit, wiedervorlage_am")
    .eq("status", "offen")
    .is("erinnert_am", null)
    .lte("wiedervorlage_am", heute());
  for (const p of data ?? []) {
    await db().from("tasks").insert({
      titel: `Nachfassen: ${p.titel}`,
      grund: `Seit ${p.seit} keine Antwort${p.gegenpartei ? ` von ${p.gegenpartei}` : ""}. Erwartet: ${p.worauf ?? "Rückmeldung"}.`,
      quelle: "mail",
      pendenz_id: p.id,
      faellig_am: p.wiedervorlage_am,
    });
    await db().from("pendenzen").update({ erinnert_am: new Date().toISOString() }).eq("id", p.id);
    await log("mail", "pendenz_faellig", p.id, p.titel);
  }
  return data?.length ?? 0;
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

  const faellig = await faelligePendenzen();
  const { ok, fehler } = await offeneVerarbeiten(accounts, frist);
  return `${neu} neu, ${ok} verarbeitet, ${fehler} Fehler${faellig ? `, ${faellig} Pendenzen fällig` : ""}`;
}
