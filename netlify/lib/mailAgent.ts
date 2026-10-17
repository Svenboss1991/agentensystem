import { ausgangPruefen, einordnen, entwerfen, istZeitproblem, type AkteKurz, type AkteZuordnung, type Einordnung } from "./claude.js";
import { db, log, type AccountRow, type AkteRow, type Agent, type Kategorie, type Marke, type MessageRow } from "./db.js";
import { envOptional } from "./env.js";
import { providerFor } from "./providers/index.js";
import type { FetchResult, IncomingMail } from "./providers/types.js";

const START_TAGE = Number(envOptional("MAIL_START_TAGE") ?? 3);
// Gesendete Mails beim ersten Mal weiter zurück lesen, damit laufende Anfragen als Akte auftauchen.
const START_TAGE_GESENDET = Number(envOptional("MAIL_START_TAGE_GESENDET") ?? 14);
const MAX_PRO_POSTFACH = Number(envOptional("MAIL_MAX_PRO_LAUF") ?? 20);
// Mails, die pro Lauf gleichzeitig eingeordnet werden. Ein Lauf hat höchstens 30 Sekunden.
const PARALLEL = Number(envOptional("MAIL_PARALLEL") ?? 4);
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

  // Gesendete Mails sind für die Akten da. Ein Fehler hier soll den Posteingang nicht blockieren.
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

// ─── Schritt 2: einordnen, zuteilen, Entwürfe, Aufgaben, Akten ───────────────

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

async function offeneAkten(): Promise<AkteRow[]> {
  const { data } = await db()
    .from("akten")
    .select("id, nummer, titel, gegenpartei, am_zug, wiedervorlage_am")
    .eq("status", "offen")
    .order("zuletzt_aktiv", { ascending: false })
    .limit(40);
  return (data ?? []) as AkteRow[];
}

/** Akte einer früheren Mail im selben Faden (Antwort-Header oder Gmail-/Outlook-Konversation). */
async function akteImFaden(row: MessageRow): Promise<string | null> {
  const ids = fadenIds(row);
  const bedingungen = [
    ids.length ? `message_id_header.in.(${ids.map((i) => `"${i.replace(/"/g, "")}"`).join(",")})` : null,
    row.thread_ref ? `thread_ref.eq."${row.thread_ref.replace(/"/g, "")}"` : null,
  ].filter(Boolean);
  if (!bedingungen.length) return null;
  const { data } = await db()
    .from("messages")
    .select("akte_id")
    .not("akte_id", "is", null)
    .neq("id", row.id)
    .or(bedingungen.join(","))
    .limit(1);
  return (data?.[0]?.akte_id as string | undefined) ?? null;
}

async function kandidaten(row: MessageRow): Promise<AkteKurz[]> {
  const [akten, faden] = await Promise.all([offeneAkten(), akteImFaden(row)]);
  return akten.map((a) => ({ ...a, imFaden: a.id === faden }));
}

async function ereignis(akteId: string, text: string): Promise<void> {
  await db().from("akte_eintraege").insert({ akte_id: akteId, typ: "ereignis", text, von: "mail" });
}

async function akteAufgabenSchliessen(akteId: string): Promise<void> {
  await db()
    .from("tasks")
    .update({ status: "erledigt", erledigt_am: new Date().toISOString() })
    .eq("akte_id", akteId)
    .eq("status", "offen");
}

/** Mail einer Akte zuordnen (oder eine neue eröffnen) und den Stand der Akte nachführen. Gibt die Akte-ID zurück. */
async function akteNachfuehren(
  row: MessageRow,
  z: AkteZuordnung,
  gegenparteiAdresse: string | null,
  marke: Marke | null,
): Promise<string | null> {
  const ausgehend = row.richtung === "ausgehend";
  let akteId = z.akte_id;

  if (!akteId && z.neue_akte) {
    const n = z.neue_akte;
    const { data, error } = await db()
      .from("akten")
      .insert({
        titel: n.titel,
        gegenpartei: n.gegenpartei,
        gegenpartei_adresse: gegenparteiAdresse,
        am_zug: n.am_zug,
        wiedervorlage_am: n.am_zug === "gegenseite" && istDatum(n.wiedervorlage_am) ? n.wiedervorlage_am : null,
        seit: row.empfangen_am?.slice(0, 10) ?? heute(),
        message_id: row.id,
        marke,
        bereich: n.bereich,
      })
      .select("id, nummer")
      .single();
    if (error) throw new Error(`Akte anlegen: ${error.message}`);
    akteId = data.id as string;
    await ereignis(akteId, `Akte eröffnet (${ausgehend ? "gesendete" : "eingegangene"} Mail «${row.betreff ?? ""}»)`);
    await log("mail", "akte_eroeffnet", akteId, `${data.nummer} ${n.titel}`);
  }
  if (!akteId) return null;

  await db().from("messages").update({ akte_id: akteId }).eq("id", row.id);
  const jetzt = new Date().toISOString();
  const aenderung: Record<string, unknown> = { zuletzt_aktiv: jetzt };

  if (z.aenderung === "erledigt") {
    Object.assign(aenderung, { status: "erledigt", erledigt_am: jetzt });
    await akteAufgabenSchliessen(akteId);
    // Erledigte Akte: ihre Mails dürfen ins Postfach-Ordner wandern.
    await db().from("messages").update({ status: "erledigt" }).eq("akte_id", akteId).eq("status", "verarbeitet");
    await ereignis(akteId, "Als erledigt markiert");
  } else if (z.aenderung === "sven_am_zug") {
    Object.assign(aenderung, { am_zug: "sven", erinnert_am: null });
    await ereignis(akteId, "Sven ist am Zug");
  } else if (z.aenderung === "gegenseite_am_zug" || ausgehend) {
    // Sven hat gehandelt (gesendet) oder wartet wieder: offene Aufgaben dieser Akte sind damit erledigt.
    Object.assign(aenderung, { am_zug: "gegenseite", erinnert_am: null });
    if (istDatum(z.wiedervorlage_am)) aenderung.wiedervorlage_am = z.wiedervorlage_am;
    await akteAufgabenSchliessen(akteId);
    if (z.aenderung === "gegenseite_am_zug") {
      await ereignis(akteId, `Warten auf Gegenseite${istDatum(z.wiedervorlage_am) ? `, Wiedervorlage ${z.wiedervorlage_am}` : ""}`);
    }
  }
  await db().from("akten").update(aenderung).eq("id", akteId);
  return akteId;
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
  const akten = await kandidaten(row);
  const e = await einordnen(alsMail(row), account, akten, heute(), frist);
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
    // Wandert beim nächsten Ablage-Schritt in den Ordner «Newsletter».
    await db().from("messages").update({ status: "archiviert" }).eq("id", row.id);
    return;
  }

  const akteId = await akteNachfuehren(row, e.akte, row.absender.toLowerCase(), e.marke === "keine" ? null : e.marke);

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
      akte_id: akteId,
      faellig_am: istDatum(e.faellig_am) ? e.faellig_am : null,
    });
    await log("mail", "aufgabe_angelegt", row.id, e.aufgabe_titel);
  }

  await db().from("messages").update({ status: "verarbeitet", fehler: null }).eq("id", row.id);
}

async function ausgangVerarbeiten(row: MessageRow, account: AccountRow, frist: number): Promise<void> {
  const akten = await kandidaten(row);
  const z = await ausgangPruefen(alsMail(row), account, akten, heute(), frist);
  await akteNachfuehren(row, z, ersteAdresse(row.empfaenger), account.marke === "keine" ? null : account.marke);
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

// ─── Schritt 3: fällige Akten → Nachfass-Aufgabe ─────────────────────────────

/** Sven-Regel: Solange er nur wartet, keine Erinnerung. Erst wenn die Wiedervorlage erreicht ist, muss er handeln. */
async function faelligeAkten(): Promise<number> {
  const { data } = await db()
    .from("akten")
    .select("id, nummer, titel, gegenpartei, worauf, seit, wiedervorlage_am")
    .eq("status", "offen")
    .eq("am_zug", "gegenseite")
    .is("erinnert_am", null)
    .lte("wiedervorlage_am", heute());
  for (const a of data ?? []) {
    await db().from("tasks").insert({
      titel: `Nachfassen: ${a.titel}`,
      grund: `${a.nummer}: seit ${a.seit} keine Antwort${a.gegenpartei ? ` von ${a.gegenpartei}` : ""}.`,
      quelle: "mail",
      akte_id: a.id,
      faellig_am: a.wiedervorlage_am,
    });
    await db().from("akten").update({ erinnert_am: new Date().toISOString() }).eq("id", a.id);
    await ereignis(a.id, "Wiedervorlage erreicht, Nachfassen als Aufgabe gestellt");
    await log("mail", "akte_faellig", a.id, `${a.nummer} ${a.titel}`);
  }
  return data?.length ?? 0;
}

// ─── Schritt 4: erledigte Mails im Postfach ablegen ──────────────────────────

const ORDNER: Record<string, string> = {
  privat: "Privat",
  finanzen: "Finanzen",
  behoerden: "Behörden & Recht",
  tamelo: "Tamelo",
  don_sombrerito: "Don Sombrerito",
  clave_suiza: "Clave Suiza",
  newsletter: "Newsletter",
};

interface AblageZeile {
  id: string;
  account_id: string;
  extern_id: string;
  status: string;
  kategorie: Kategorie | null;
  marke: Marke | null;
  zugewiesen_an: Agent | null;
  akten: { bereich: string } | null;
  drafts: { status: string }[];
  tasks: { status: string }[];
}

function ordnerFuer(m: AblageZeile): string {
  if (m.kategorie === "newsletter") return ORDNER.newsletter;
  if (m.akten?.bereich) return ORDNER[m.akten.bereich] ?? ORDNER.privat;
  if (m.kategorie === "finanz") return ORDNER.finanzen;
  if (m.marke && m.marke !== "keine") return ORDNER[m.marke];
  return ORDNER.privat;
}

/**
 * Eine Mail ist fertig, wenn Sven nichts mehr damit tun muss: erledigt oder Newsletter,
 * oder eingeordnet ohne offenen Entwurf, ohne offene Aufgabe und nicht auf «Zum Lesen».
 */
function istFertig(m: AblageZeile): boolean {
  if (m.status === "erledigt" || m.status === "archiviert") return true;
  if (m.status !== "verarbeitet") return false;
  const offen = m.drafts.some((d) => d.status === "offen" || d.status === "fehler") || m.tasks.some((t) => t.status === "offen");
  return !offen && m.zugewiesen_an !== "sven";
}

async function ablegen(accounts: Map<string, AccountRow>): Promise<number> {
  const { data } = await db()
    .from("messages")
    // akten ist doppelt mit messages verknüpft; der Hinweis wählt die Beziehung über messages.akte_id.
    .select(
      "id, account_id, extern_id, status, kategorie, marke, zugewiesen_an, akten!messages_akte_id_fkey(bereich), drafts(status), tasks(status)",
    )
    .eq("richtung", "eingehend")
    .is("abgelegt_am", null)
    .is("ablage_fehler", null)
    .in("status", ["erledigt", "archiviert", "verarbeitet"])
    .order("empfangen_am", { ascending: true })
    .limit(80);
  const fertig = ((data ?? []) as unknown as AblageZeile[]).filter(istFertig).slice(0, 40);

  let abgelegt = 0;
  const proPostfach = new Map<string, AblageZeile[]>();
  for (const m of fertig) proPostfach.set(m.account_id, [...(proPostfach.get(m.account_id) ?? []), m]);

  await Promise.all(
    [...proPostfach].map(async ([accountId, mails]) => {
      const account = accounts.get(accountId);
      if (!account) return;
      try {
        const ergebnisse = await mitZeitlimit(
          providerFor(account).ablegen(
            account,
            mails.map((m) => ({ externId: m.extern_id, ordner: ordnerFuer(m) })),
          ),
          12_000,
          `Ablage ${account.adresse}`,
        );
        for (const m of mails) {
          const r = ergebnisse.find((x) => x.externId === m.extern_id);
          if (!r) continue;
          await db()
            .from("messages")
            .update(
              r.fehler
                ? { ablage_fehler: r.fehler }
                : { abgelegt_am: new Date().toISOString(), ablage_ordner: ordnerFuer(m) },
            )
            .eq("id", m.id);
          if (!r.fehler) abgelegt++;
        }
      } catch (err) {
        await log("mail", "ablage_fehler", account.adresse, err instanceof Error ? err.message : String(err));
      }
    }),
  );
  if (abgelegt) await log("mail", "abgelegt", null, `${abgelegt} Mails in Ordner verschoben`);
  return abgelegt;
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

  const faellig = await faelligeAkten();
  const [{ ok, fehler }, abgelegt] = await Promise.all([offeneVerarbeiten(accounts, frist), ablegen(accounts)]);
  return `${neu} neu, ${ok} verarbeitet, ${abgelegt} abgelegt, ${fehler} Fehler${faellig ? `, ${faellig} Akten zur Wiedervorlage` : ""}`;
}
