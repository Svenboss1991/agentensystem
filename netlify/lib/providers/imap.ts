import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import type { AccountRow, MessageRow } from "../db.js";
import { secretFor } from "../env.js";
import { parseRaw, replySubject, type FetchResult, type IncomingMail, type MailProvider } from "./types.js";

function imapClient(account: AccountRow): ImapFlow {
  return new ImapFlow({
    host: account.imap_host!,
    port: account.imap_port ?? 993,
    secure: true,
    auth: { user: account.benutzer ?? account.adresse, pass: secretFor(account.secret_ref, "PASSWORD") },
    logger: false,
    // Kurze Zeitlimits: ein hängender Server soll einen Fehler melden, statt den ganzen Lauf zu blockieren.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

/** imapflow meldet oft nur «Command failed»; die Antwort des Servers steht in Zusatzfeldern. */
function klarerFehler(err: unknown): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  const e = err as Error & { authenticationFailed?: boolean; responseText?: string; serverResponseCode?: string };
  if (e.authenticationFailed) {
    return new Error(`Anmeldung abgelehnt (Benutzername oder Passwort falsch)${e.responseText ? `: ${e.responseText}` : ""}`);
  }
  const details = [e.serverResponseCode, e.responseText].filter(Boolean).join(" ");
  return details ? new Error(`${e.message}: ${details}`) : e;
}

async function withImap<T>(account: AccountRow, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const client = imapClient(account);
  try {
    await client.connect();
  } catch (err) {
    throw klarerFehler(err);
  }
  try {
    return await fn(client);
  } catch (err) {
    throw klarerFehler(err);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/** Neue Mails eines Ordners ab der zuletzt gesehenen UID (oder ab Startdatum beim ersten Mal). */
async function ordnerLesen(
  client: ImapFlow,
  pfad: string,
  stand: { uidvalidity: number | null; letzteUid: number | null },
  startDatum: Date,
  max: number,
  prefix: string,
): Promise<{ mails: IncomingMail[]; uidvalidity: number; letzteUid: number }> {
  const lock = await client.getMailboxLock(pfad);
  try {
    const box = client.mailbox;
    if (!box) throw new Error(`${pfad} nicht verfügbar`);
    const uidValidity = Number(box.uidValidity);
    const resync = stand.uidvalidity !== uidValidity || stand.letzteUid == null;

    let uids: number[];
    if (resync) {
      // Erster Lauf oder Ordner neu nummeriert: ab Startdatum, Duplikate fängt die DB ab.
      uids = (await client.search({ since: startDatum }, { uid: true })) || [];
    } else {
      const ab = stand.letzteUid! + 1;
      uids = ((await client.search({ uid: `${ab}:*` }, { uid: true })) || []).filter((u) => u >= ab);
    }
    uids.sort((a, b) => a - b);
    uids = uids.slice(0, max);

    const mails: IncomingMail[] = [];
    if (uids.length > 0) {
      for await (const msg of client.fetch(uids, { uid: true, source: true, internalDate: true }, { uid: true })) {
        if (!msg.source) continue;
        const internal = msg.internalDate ? new Date(msg.internalDate) : undefined;
        mails.push(await parseRaw(msg.source, `${prefix}${msg.uid}`, null, internal));
      }
    }
    const letzte =
      uids.length > 0 ? uids[uids.length - 1] : resync ? Math.max(0, Number(box.uidNext) - 1) : stand.letzteUid!;
    return { mails, uidvalidity: uidValidity, letzteUid: letzte };
  } finally {
    lock.release();
  }
}

async function gesendetOrdner(client: ImapFlow): Promise<string | undefined> {
  const ordner = await client.list();
  return (
    ordner.find((f) => f.specialUse === "\\Sent")?.path ??
    ordner.find((f) => /^(inbox\.)?(sent|gesendet|sent items|sent messages|enviados)$/i.test(f.path))?.path
  );
}

export const imapProvider: MailProvider = {
  async fetchNew(account, startDatum, max): Promise<FetchResult> {
    return withImap(account, async (client) => {
      const r = await ordnerLesen(
        client,
        "INBOX",
        { uidvalidity: account.sync_uidvalidity, letzteUid: account.sync_letzte_uid },
        startDatum,
        max,
        "",
      );
      return { mails: r.mails, sync: { sync_uidvalidity: r.uidvalidity, sync_letzte_uid: r.letzteUid } };
    });
  },

  async fetchSent(account, startDatum, max): Promise<FetchResult> {
    return withImap(account, async (client) => {
      const pfad = await gesendetOrdner(client);
      if (!pfad) return { mails: [], sync: {} };
      const r = await ordnerLesen(
        client,
        pfad,
        { uidvalidity: account.sync_sent_uidvalidity, letzteUid: account.sync_sent_letzte_uid },
        startDatum,
        max,
        "sent:",
      );
      return { mails: r.mails, sync: { sync_sent_uidvalidity: r.uidvalidity, sync_sent_letzte_uid: r.letzteUid } };
    });
  },

  async archive(account, externId) {
    const ziel = account.archiv_ordner || "Archive";
    await withImap(account, async (client) => {
      const folders = await client.list();
      if (!folders.some((f) => f.path === ziel)) await client.mailboxCreate(ziel);
      const lock = await client.getMailboxLock("INBOX");
      try {
        await client.messageMove(externId, ziel, { uid: true });
      } finally {
        lock.release();
      }
    });
  },

  async sendReply(account: AccountRow, original: MessageRow, text: string) {
    const transport = nodemailer.createTransport({
      host: account.smtp_host!,
      port: account.smtp_port ?? 465,
      secure: (account.smtp_port ?? 465) === 465,
      auth: { user: account.benutzer ?? account.adresse, pass: secretFor(account.secret_ref, "PASSWORD") },
    });
    const mail = {
      from: account.anzeigename ? { name: account.anzeigename, address: account.adresse } : account.adresse,
      to: original.absender,
      subject: replySubject(original.betreff),
      text,
      inReplyTo: original.message_id_header ?? undefined,
      references: original.message_id_header ?? undefined,
    };
    const info = await transport.sendMail(mail);

    // Kopie in «Gesendet» ablegen, damit die Antwort auch im normalen Mailprogramm sichtbar ist.
    const raw = await new MailComposer({ ...mail, messageId: info.messageId }).compile().build();
    await withImap(account, async (client) => {
      const sent = await gesendetOrdner(client);
      if (sent) await client.append(sent, raw, ["\\Seen"]);
    }).catch((e) => console.warn("Kopie in Gesendet fehlgeschlagen:", e));
  },
};
