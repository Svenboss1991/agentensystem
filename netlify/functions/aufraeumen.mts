import { json, nichtSven } from "../lib/auth.js";
import { absenderVerschieben, aufraeumerFuer, neueAbsenderBewerten } from "../lib/aufraeumen.js";
import { istZeitproblem } from "../lib/claude.js";
import { db, type AccountRow } from "../lib/db.js";

// Aufräumen von Hand (Knopf «Aufräumen» bei einem Postfach) und Svens Entscheide bei unsicheren Absendern.

export default async (req: Request) => {
  if (req.method !== "POST") return json(405, { fehler: "Nur POST" });
  const verweigert = await nichtSven(req);
  if (verweigert) return json(403, { fehler: `Nicht erlaubt: ${verweigert}` });

  const start = Date.now();
  const body = (await req.json().catch(() => ({}))) as {
    aktion?: string;
    account_id?: string;
    kategorie?: string;
    absender?: string[];
    bekannt?: string[];
    urteil?: "muell" | "behalten";
  };
  const { data: account } = await db().from("accounts").select("*").eq("id", body.account_id ?? "").maybeSingle<AccountRow>();
  if (!account?.aktiv) return json(400, { fehler: "Postfach nicht gefunden oder nicht verbunden" });
  const kategorie = body.kategorie ?? "";

  try {
    if (body.aktion === "vorschau") return json(200, await aufraeumerFuer(account).vorschau(account));

    if (body.aktion === "schritt") {
      // «Jetzt aufräumen»: eine Kategorie bearbeiten wie der automatische Lauf. Die Seite ruft wiederholt auf,
      // bis «weiter» null ist.
      const kategorien = Object.keys(aufraeumerFuer(account).kategorien);
      const index = Number((body as { index?: number }).index ?? 0);
      const key = kategorien[index];
      if (!key) return json(200, { verschoben: 0, unsicher: 0, weiter: null });
      const { bewertet, weitere } = await neueAbsenderBewerten(account, key, start + 18_000);
      const { data: muell } = await db()
        .from("aufraeum_absender")
        .select("adresse")
        .eq("account_id", account.id)
        .eq("kategorie", key)
        .eq("urteil", "muell");
      const r = await absenderVerschieben(account, key, (muell ?? []).map((m) => m.adresse as string), start + 25_000, "sven");
      const nochArbeit = weitere > 0 || r.rest.length > 0;
      return json(200, {
        titel: aufraeumerFuer(account).kategorien[key],
        verschoben: r.verschoben,
        unsicher: bewertet.filter((b) => b.urteil === "unsicher").length,
        weiter: nochArbeit ? index : index + 1 < kategorien.length ? index + 1 : null,
      });
    }

    if (!aufraeumerFuer(account).kategorien[kategorie]) return json(400, { fehler: "Unbekannte Kategorie" });

    if (body.aktion === "analyse") {
      const { bewertet, weitere } = await neueAbsenderBewerten(account, kategorie, start + 26_000, body.bekannt ?? []);
      return json(200, { absender: bewertet, weitere });
    }

    if (body.aktion === "papierkorb") {
      return json(200, await absenderVerschieben(account, kategorie, body.absender ?? [], start + 20_000, "sven"));
    }

    if (body.aktion === "entscheiden") {
      // Sven entscheidet bei einem unsicheren Absender; bei «Müll» wird gleich verschoben.
      const adressen = body.absender ?? [];
      await db()
        .from("aufraeum_absender")
        .update({ urteil: body.urteil, entschieden_von: "sven", grund: "von Sven entschieden", aktualisiert_am: new Date().toISOString() })
        .eq("account_id", account.id)
        .eq("kategorie", kategorie)
        .in("adresse", adressen);
      if (body.urteil === "muell") return json(200, await absenderVerschieben(account, kategorie, adressen, start + 20_000, "sven"));
      return json(200, { verschoben: 0, rest: [] });
    }

    return json(400, { fehler: "Unbekannte Aktion" });
  } catch (err) {
    if (istZeitproblem(err)) return json(504, { fehler: "Die Prüfung hat zu lange gedauert, bitte nochmals versuchen" });
    return json(500, { fehler: err instanceof Error ? err.message : String(err) });
  }
};
