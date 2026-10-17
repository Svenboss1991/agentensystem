# Agentensystem – Phase 1

Datenbank, Mail-Agent und die Seite «Heute». Bauplan siehe `BAUPLAN.md`.

```
supabase/migrations/   Datenbank (alle Tabellen aus dem Bauplan, RLS: nur Sven)
netlify/functions/     mail-agent-tick (alle 5 Min.), mail-agent-run (Knopf «Aktualisieren»),
                       send-draft, oauth-start/oauth-callback (Gmail/Hotmail verbinden)
netlify/lib/           Mail-Agent, Claude-Aufrufe, Postfach-Anbindungen (IMAP, Gmail, Outlook)
src/                   Seite «Heute» (React + Vite + Tailwind)
```

## Was der Mail-Agent tut

Alle 5 Minuten (läuft im Netlify-Gratis-Abo; pro Lauf höchstens 30 Sekunden, darum werden pro Lauf bis zu `MAIL_PARALLEL` Mails eingeordnet, der Rest im nächsten Lauf):

1. Neue Mails holen und in `messages` speichern (Duplikate werden ignoriert).
2. Mit Claude Sprache (DE/EN/ES/andere), Kategorie und Marke bestimmen.
3. Zuteilen: `finanz` → Finanz-Agent, `service` → Service-Agent, `privat`/`unklar`/`geschäftlich` → Sven, `newsletter` → Ordner «Newsletter».
4. Bei `service`/`geschäftlich` mit Antwortbedarf: Entwurf in `drafts`, bei EN/ES mit deutscher Übersetzung. Fakten nur aus **geprüften** Einträgen in `knowledge`, sonst Platzhalter `[…]`.
5. Nur wenn Sven selbst handeln muss: Eintrag in `tasks`.
7. **Ablage im Postfach:** Erledigte Mails (gelesen, beantwortet, Akte erledigt, oder nichts zu tun) wandern in allen Postfächern in Bereichs-Ordner: Privat, Finanzen, Behörden & Recht, Tamelo, Don Sombrerito, Clave Suiza, Newsletter (Gmail: Labels). Gesendete Mails bleiben in «Gesendet».
6. **Akten:** Jede Angelegenheit, die nachverfolgt werden muss (Anfrage, Reklamation, Bank, Behörde …), bekommt eine Akte mit Fallnummer `F-<Jahr>-<Nr>`. Der Agent legt eingehende und gesendete Mails in die passende Akte (Mail-Faden oder Inhalt) und eröffnet neue Akten selbst. Jede Akte hat einen Verlauf (Mails, Notizen, Ereignisse), den Stand «ich warte» (mit Wiedervorlage) oder «ich bin dran». Ist die Wiedervorlage erreicht, entsteht die Aufgabe «Nachfassen: …». Ansicht: `#/akten` und `#/akte/<id>`.

Grenzen: Der Agent sendet nie selbst. Gesendet wird nur über «Freigeben & senden» auf der Seite «Heute» (Funktion `send-draft` prüft, dass Svens Login dahintersteht). Nichts wird gelöscht. Jede Aktion steht in `agent_log`.

Finanz- und Service-Mails sind schon dem jeweiligen Agenten zugeteilt (`zugewiesen_an`), auch wenn diese Agenten erst in Phase 2 und 3 entstehen. Bis dahin erscheinen sie auf «Heute» nur, wenn Sven handeln muss oder ein Entwurf vorliegt.

## Einrichtung

### 1. Supabase
1. Projekt anlegen. Unter *Authentication → Sign In / Providers* «Allow new users to sign up» **ausschalten**, dann unter *Users → Add user → Create new user* Svens Adresse mit Passwort anlegen («Auto Confirm User» anhaken).
2. Migration ausführen: `supabase db push` oder Inhalt von `supabase/migrations/…_init.sql` im SQL-Editor ausführen.
3. Unter *Authentication → URL Configuration* die Netlify-Adresse als Site URL eintragen.

### 2. Netlify
1. Repository verbinden. Build-Einstellungen kommen aus `netlify.toml`.
2. Umgebungsvariablen aus `.env.example` eintragen.
3. Deploy. Die geplante Funktion läuft erst auf der produktiven Seite.

### 3. Besitzer festlegen
Im SQL-Editor:
```sql
insert into public.app_owner (user_id) select id from auth.users where email = '<svens-adresse>';
```

### 4. Postfächer
`supabase/postfaecher.example.sql` anpassen und ausführen. Pro Postfach die Variable `MAIL_<secret_ref>_PASSWORD` (IMAP) bzw. `MAIL_<secret_ref>_REFRESH_TOKEN` (OAuth) in Netlify setzen.

Hostpoint/Hostinger: IMAP-Port 993, SMTP-Port 465 (SSL). Hosts in der Vorlage vor dem Start mit den Angaben im Kundencenter abgleichen. Der Archivordner heisst je nach Server `Archive` oder `INBOX.Archive`.

### 5. Gmail und Hotmail verbinden – macht Sven selbst
Einmalig eine OAuth-App anlegen, die Werte in Netlify eintragen, dann auf «Heute» unter «Postfächer» auf **Verbinden** klicken. Redirect-URI für beide: `https://<seite>.netlify.app/.netlify/functions/oauth-callback`.

**Hotmail:** Im Azure-Portal *App registrations* → neue App, Kontotyp «Persönliche Microsoft-Konten», Plattform «Web» mit obiger Redirect-URI. Unter *Certificates & secrets* ein Client-Secret erstellen. Netlify: `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`.

**Gmail:** In der Google Cloud Console Gmail API aktivieren, OAuth-Client «Webanwendung» mit obiger Redirect-URI. Im Testmodus laufen Tokens nach 7 Tagen ab, für Dauerbetrieb die App veröffentlichen. Netlify: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

Die Refresh-Tokens liegen in der Tabelle `oauth_tokens` (nur für den Service-Role-Schlüssel lesbar), weil Microsoft und Google sie laufend erneuern.

### 6. Wissensbasis
Einträge in `knowledge` anlegen (Marke, Thema, Antwort, Sprache). Der Agent nutzt nur Einträge mit `geprueft = true`.

## Entwicklung
```
npm install
npm run dev        # Frontend (VITE_SUPABASE_* in .env)
npm run build      # Typprüfung + Build
netlify dev        # Frontend + Funktionen lokal
```
Modell: `claude-opus-5-5` (änderbar über `CLAUDE_MODEL`). Abgelehnte Anfragen fallen serverseitig automatisch auf ein anderes Modell zurück.

## Nächste Schritte (aus dem Bauplan)
- Phase 2: Service-Agent (automatische Standardantworten, Nachfass-Sequenzen), Marketing-Agent.
- Phase 3: Finanz-Agent, dann füllt «Zahlen von gestern» auch Umsätze.
- Phase 4: CEO-Agent mit Empfehlung (④ auf der Seite «Heute»).
