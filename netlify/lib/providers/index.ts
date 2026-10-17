import type { AccountRow } from "../db.js";
import { gmailProvider } from "./gmail.js";
import { imapProvider } from "./imap.js";
import { outlookProvider } from "./outlook.js";
import type { MailProvider } from "./types.js";

export function providerFor(account: AccountRow): MailProvider {
  if (account.typ === "imap") return imapProvider;
  if (account.provider === "gmail") return gmailProvider;
  if (account.provider === "hotmail") return outlookProvider;
  throw new Error(`Kein Anbieter für ${account.provider}/${account.typ}`);
}
