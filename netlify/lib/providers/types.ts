import { simpleParser, type ParsedMail } from "mailparser";
import type { AccountRow, MessageRow } from "../db.js";

export interface IncomingMail {
  externId: string;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string | null;
  threadRef: string | null;
  absender: string;
  absenderName: string | null;
  empfaenger: string | null;
  betreff: string | null;
  text: string;
  empfangenAm: Date;
}

/** Neuer Synchronisationsstand, wird nach erfolgreichem Speichern in accounts geschrieben. */
export type SyncState = Partial<
  Pick<
    AccountRow,
    | "sync_uidvalidity"
    | "sync_letzte_uid"
    | "sync_seit"
    | "sync_sent_uidvalidity"
    | "sync_sent_letzte_uid"
    | "sync_sent_seit"
  >
>;

export interface FetchResult {
  mails: IncomingMail[];
  sync: SyncState;
}

export interface Ablage {
  externId: string;
  ordner: string;
}

export interface AblageErgebnis {
  externId: string;
  fehler?: string;
}

export interface MailProvider {
  fetchNew(account: AccountRow, startDatum: Date, max: number): Promise<FetchResult>;
  /** Gesendete Mails (für Pendenzen). externId ist mit «sent:» vorangestellt. */
  fetchSent(account: AccountRow, startDatum: Date, max: number): Promise<FetchResult>;
  /** Erledigte Mails in Bereichs-Ordner verschieben (Ordner werden bei Bedarf angelegt). Nie löschen. */
  ablegen(account: AccountRow, eintraege: Ablage[]): Promise<AblageErgebnis[]>;
  sendReply(account: AccountRow, original: MessageRow, text: string): Promise<void>;
}

export function replySubject(betreff: string | null): string {
  const s = betreff?.trim() || "";
  return /^(re|aw|antw):/i.test(s) ? s : `Re: ${s}`;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function parseRaw(
  raw: Buffer | string,
  externId: string,
  threadRef: string | null,
  fallbackDate?: Date,
): Promise<IncomingMail> {
  const parsed: ParsedMail = await simpleParser(raw);
  const from = parsed.from?.value[0];
  const to = Array.isArray(parsed.to) ? parsed.to.map((a) => a.text).join(", ") : parsed.to?.text;
  const refs = Array.isArray(parsed.references) ? parsed.references.join(" ") : parsed.references;
  return {
    externId,
    messageIdHeader: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references: refs ?? null,
    threadRef,
    absender: from?.address ?? "unbekannt",
    absenderName: from?.name || null,
    empfaenger: to ?? null,
    betreff: parsed.subject ?? null,
    text: parsed.text?.trim() || (parsed.html ? htmlToText(parsed.html) : ""),
    empfangenAm: parsed.date ?? fallbackDate ?? new Date(),
  };
}
