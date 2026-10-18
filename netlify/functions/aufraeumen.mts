import { json, nichtSven } from "../lib/auth.js";
import { absenderVerschieben, aufraeumerFuer, aufraeumSchritt, istWoche, neueAbsenderBewerten } from "../lib/aufraeumen.js";
import { istZeitproblem } from "../lib/claude.js";
import { db, log, type AccountRow } from "../lib/db.js";

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
    ids?: string[];
    merken?: boolean;
  };
  const { data: account } = await db().from("accounts").select("*").eq("id", body.account_id ?? "").maybeSingle<AccountRow>();
  if (!account?.aktiv) return json(400, { fehler: "Postfach nicht gefunden oder nicht verbunden" });
  const kategorie = body.kategorie ?? "";

  try {
    if (body.aktion === "vorschau") return json(200, await aufraeumerFuer(account).vorschau(account));

    if (body.aktion === "schritt") {
      // «Jetzt aufräumen»: wie der automatische Lauf, Seite für Seite durch alle Jahre.
      // Die Seite ruft wiederholt auf, bis «weiter» null ist.
      const kategorien = Object.keys(aufraeumerFuer(account).kategorien).filter((k) => !istWoche(k));
      const index = Number((body as { index?: number }).index ?? 0);
      const key = kategorien[index];
      if (!key) return json(200, { verschoben: 0, unsicher: 0, weiter: null });
      const r = await aufraeumSchritt(account, key, start, "sven");
      return json(200, {
        titel: aufraeumerFuer(account).kategorien[key],
        verschoben: r.verschoben,
        vorgelegt: r.vorgelegt,
        muell: r.muell,
        behalten: r.behalten,
        unsicher: r.unsicher,
        geprueft: r.geprueft,
        weiter: !r.kategorieFertig ? index : index + 1 < kategorien.length ? index + 1 : null,
      });
    }

    if (body.aktion === "vorlage_lesen") {
      // Eine vorgelegte Mail ganz anzeigen.
      const { data: v } = await db().from("aufraeum_vorlage").select("kategorie, mail_id").eq("id", body.ids?.[0] ?? "").eq("account_id", account.id).maybeSingle();
      if (!v) return json(404, { fehler: "Mail nicht gefunden" });
      return json(200, { mail: await aufraeumerFuer(account).mailLesen(account, v.kategorie, v.mail_id) });
    }

    if (body.aktion === "vorlage_entscheiden") {
      // Sven entscheidet über vorgelegte Mails (höchstens 300 pro Aufruf, die Seite schickt den Rest nach).
      const { data: zeilen } = await db()
        .from("aufraeum_vorlage")
        .select("id, kategorie, mail_id, adresse, name")
        .eq("account_id", account.id)
        .eq("status", "offen")
        .in("id", (body.ids ?? []).slice(0, 300));
      const liste = zeilen ?? [];
      if (body.urteil === "muell") {
        const nachKategorie = new Map<string, string[]>();
        for (const z of liste) nachKategorie.set(z.kategorie, [...(nachKategorie.get(z.kategorie) ?? []), z.mail_id]);
        for (const [k, ids] of nachKategorie) await aufraeumerFuer(account).einzelnVerschieben(account, k, ids);
        if (liste.length) await log("sven", "aufgeraeumt", account.adresse, `${liste.length} vorgelegte Mails in den Papierkorb`);
        // «Alle von diesem Absender»: auch künftig als Müll behandeln.
        if (body.merken) {
          const absender = new Map(liste.map((z) => [`${z.kategorie}|${z.adresse}`, z]));
          await db()
            .from("aufraeum_absender")
            .upsert(
              [...absender.values()].map((z) => ({
                account_id: account.id,
                kategorie: z.kategorie,
                adresse: z.adresse,
                name: z.name,
                urteil: "muell",
                grund: "von Sven entschieden",
                entschieden_von: "sven",
                aktualisiert_am: new Date().toISOString(),
              })),
              { onConflict: "account_id,kategorie,adresse" },
            );
        }
      }
      if (liste.length) {
        await db()
          .from("aufraeum_vorlage")
          .update({ status: body.urteil === "muell" ? "papierkorb" : "behalten", entschieden_am: new Date().toISOString() })
          .in("id", liste.map((z) => z.id));
      }
      return json(200, { erledigt: liste.length });
    }

    if (!aufraeumerFuer(account).kategorien[kategorie]) return json(400, { fehler: "Unbekannte Kategorie" });

    if (body.aktion === "analyse") {
      const { bewertet, weitere } = await neueAbsenderBewerten(account, kategorie, start + 26_000, body.bekannt ?? []);
      return json(200, { absender: bewertet, weitere });
    }

    if (body.aktion === "beispiele") {
      const adresse = body.absender?.[0];
      if (!adresse) return json(400, { fehler: "Absender fehlt" });
      return json(200, { mails: await aufraeumerFuer(account).beispiele(account, kategorie, adresse, 3) });
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
