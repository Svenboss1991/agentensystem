import MailComposer from "nodemailer/lib/mail-composer";
import type { AccountRow } from "../db.js";
import { accessToken } from "./oauth.js";
import { parseRaw, replySubject, type FetchResult, type IncomingMail, type MailProvider } from "./types.js";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

async function gmail<T>(account: AccountRow, path: string, init?: RequestInit): Promise<T> {
  const token = await accessToken(account);
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`Gmail ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function lesen(account: AccountRow, ordner: "inbox" | "sent", seit: Date, max: number, prefix: string) {
  // Gmail filtert nur sekundengenau mit «after:»; Duplikate fängt der Unique-Index ab.
  const q = encodeURIComponent(`in:${ordner} after:${Math.floor(seit.getTime() / 1000)}`);
  const list = await gmail<{ messages?: { id: string; threadId: string }[] }>(account, `/messages?q=${q}&maxResults=${max}`);
  const mails: IncomingMail[] = [];
  let neuester = seit;
  // Die Liste kommt neueste zuerst; älteste zuerst verarbeiten.
  for (const m of (list.messages ?? []).reverse()) {
    const full = await gmail<{ raw: string; internalDate: string; threadId: string }>(account, `/messages/${m.id}?format=raw`);
    const internal = new Date(Number(full.internalDate));
    mails.push(await parseRaw(Buffer.from(full.raw, "base64url"), `${prefix}${m.id}`, full.threadId, internal));
    if (internal > neuester) neuester = internal;
  }
  return { mails, neuester };
}

export const gmailProvider: MailProvider = {
  async fetchNew(account, startDatum, max): Promise<FetchResult> {
    const { mails, neuester } = await lesen(account, "inbox", account.sync_seit ? new Date(account.sync_seit) : startDatum, max, "");
    return { mails, sync: { sync_seit: neuester.toISOString() } };
  },

  async fetchSent(account, startDatum, max): Promise<FetchResult> {
    const seit = account.sync_sent_seit ? new Date(account.sync_sent_seit) : startDatum;
    const { mails, neuester } = await lesen(account, "sent", seit, max, "sent:");
    return { mails, sync: { sync_sent_seit: neuester.toISOString() } };
  },

  async archive(account, externId) {
    await gmail(account, `/messages/${externId}/modify`, {
      method: "POST",
      body: JSON.stringify({ removeLabelIds: ["INBOX"] }),
    });
  },

  async sendReply(account, original, text) {
    const raw = await new MailComposer({
      from: account.anzeigename ? { name: account.anzeigename, address: account.adresse } : account.adresse,
      to: original.absender,
      subject: replySubject(original.betreff),
      text,
      inReplyTo: original.message_id_header ?? undefined,
      references: original.message_id_header ?? undefined,
    })
      .compile()
      .build();
    await gmail(account, "/messages/send", {
      method: "POST",
      body: JSON.stringify({ raw: raw.toString("base64url"), threadId: original.thread_ref ?? undefined }),
    });
  },
};
