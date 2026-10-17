import type { AccountRow } from "../db.js";
import { secretFor } from "../env.js";
import { accessToken, MICROSOFT_SCOPES, MICROSOFT_TOKEN_URL, microsoftClient } from "./oauth.js";
import { parseRaw, type IncomingMail, type MailProvider } from "./types.js";

const API = "https://graph.microsoft.com/v1.0/me";

async function graph(account: AccountRow, path: string, init?: RequestInit): Promise<Response> {
  const token = await accessToken(`outlook:${account.adresse}`, MICROSOFT_TOKEN_URL, {
    ...microsoftClient(),
    scope: MICROSOFT_SCOPES,
    refresh_token: secretFor(account.secret_ref, "REFRESH_TOKEN"),
  });
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`Graph ${path}: ${res.status} ${await res.text()}`);
  return res;
}

export const outlookProvider: MailProvider = {
  async fetchNew(account, startDatum, max) {
    const seit = account.sync_seit ? new Date(account.sync_seit) : startDatum;
    const filter = encodeURIComponent(`receivedDateTime gt ${seit.toISOString()}`);
    const list = (await (
      await graph(
        account,
        `/mailFolders/inbox/messages?$filter=${filter}&$orderby=receivedDateTime asc&$top=${max}&$select=id,conversationId,receivedDateTime`,
      )
    ).json()) as { value: { id: string; conversationId: string; receivedDateTime: string }[] };

    const mails: IncomingMail[] = [];
    let neuester = seit;
    for (const m of list.value) {
      const raw = Buffer.from(await (await graph(account, `/messages/${m.id}/$value`)).arrayBuffer());
      const empfangen = new Date(m.receivedDateTime);
      mails.push(await parseRaw(raw, m.id, m.conversationId, empfangen));
      if (empfangen > neuester) neuester = empfangen;
    }
    return { mails, sync: { sync_seit: neuester.toISOString() } };
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
