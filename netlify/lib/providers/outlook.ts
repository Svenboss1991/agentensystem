import type { AccountRow } from "../db.js";
import { accessToken } from "./oauth.js";
import { parseRaw, type FetchResult, type IncomingMail, type MailProvider } from "./types.js";

const API = "https://graph.microsoft.com/v1.0/me";

async function graph(account: AccountRow, path: string, init?: RequestInit): Promise<Response> {
  const token = await accessToken(account);
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`Hotmail ${path.split("?")[0]}: ${res.status} ${await res.text()}`);
  return res;
}

async function lesen(account: AccountRow, ordner: "inbox" | "sentitems", seit: Date, max: number, prefix: string) {
  const feld = ordner === "inbox" ? "receivedDateTime" : "sentDateTime";
  const filter = encodeURIComponent(`${feld} gt ${seit.toISOString()}`);
  const list = (await (
    await graph(
      account,
      `/mailFolders/${ordner}/messages?$filter=${filter}&$orderby=${feld} asc&$top=${max}&$select=id,conversationId,${feld}`,
    )
  ).json()) as { value: ({ id: string; conversationId: string } & Record<string, string>)[] };

  const mails: IncomingMail[] = [];
  let neuester = seit;
  for (const m of list.value) {
    const raw = Buffer.from(await (await graph(account, `/messages/${m.id}/$value`)).arrayBuffer());
    const datum = new Date(m[feld]);
    mails.push(await parseRaw(raw, `${prefix}${m.id}`, m.conversationId, datum));
    if (datum > neuester) neuester = datum;
  }
  return { mails, neuester };
}

export const outlookProvider: MailProvider = {
  async fetchNew(account, startDatum, max): Promise<FetchResult> {
    const seit = account.sync_seit ? new Date(account.sync_seit) : startDatum;
    const { mails, neuester } = await lesen(account, "inbox", seit, max, "");
    return { mails, sync: { sync_seit: neuester.toISOString() } };
  },

  async fetchSent(account, startDatum, max): Promise<FetchResult> {
    const seit = account.sync_sent_seit ? new Date(account.sync_sent_seit) : startDatum;
    const { mails, neuester } = await lesen(account, "sentitems", seit, max, "sent:");
    return { mails, sync: { sync_sent_seit: neuester.toISOString() } };
  },

  async archive(account, externId) {
    await graph(account, `/messages/${externId}/move`, {
      method: "POST",
      body: JSON.stringify({ destinationId: "archive" }),
    });
  },

  async sendReply(account, original, text) {
    await graph(account, `/messages/${original.extern_id}/reply`, {
      method: "POST",
      body: JSON.stringify({ message: { body: { contentType: "Text", content: text } } }),
    });
  },
};
