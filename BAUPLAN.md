# Bauplan: Agentensystem (Neustart)

Ziel: Ein System aus spezialisierten Agenten, die gemeinsam eine Datenbank nutzen. Sven sieht nur, was er selbst tun muss. Start mit Umsatz für **Tamelo** und **Café Don Sombrerito**.

## 1. Grundsätze

- Neustart bei null. Keine alten Personas, keine alte Modul-Spezifikation.
- Jeder Agent hat genau einen Auftrag, einen Zeitplan und eine klare Grenze zwischen **automatisch** und **Freigabe**.
- Agenten sprechen nicht per Mail miteinander, sondern über gemeinsame Tabellen (siehe 3).
- Märkte sind nicht auf CH/DE/MX begrenzt. Sprachen im Kundenservice: **Deutsch, Englisch, Spanisch**. Sprache wird pro Nachricht erkannt, nicht pro Land festgelegt.
- Sven-Regel: Erinnerungen nur, wenn er selbst handeln muss. Keine Erinnerung bei Dingen, auf die er nur wartet.
- Fremdsprachige Entwürfe (EN/ES) zeigt der Agent Sven zuerst mit deutscher Übersetzung.

## 2. Agenten im Überblick

| Agent | Auftrag | Automatisch | Freigabe durch Sven | Phase |
|---|---|---|---|---|
| **Mail** | Alle Postfächer lesen, sortieren, an Agenten verteilen, Entwürfe vorbereiten | Lesen, Labeln, Zuordnen, Newsletter archivieren, Finanzmails an Finanz, Kundenfragen an Service | Jede ausgehende Antwort | 1 |
| **Service** | Kundenanfragen je Marke beantworten, Nachfassen | Standardantworten aus Wissensbasis (Preis, Ablauf, Lieferzeit), Nachfass-Sequenz Gratis-Paket / Testphase | Alles mit Rabatt, Zusage, Reklamation, Rückerstattung | 2 |
| **Marketing** | Ideen, Texte, Anzeigen, Leads, Auswertung | Wochen-Ideen, Captions, Skripte, Anzeigenvarianten, Lead-Recherche, Wochenauswertung | Veröffentlichung, Budget, Erstkontakt an Dritte | 2 |
| **Finanz** | Anlage-Briefing und Geschäftszahlen | Kurse und Nachrichten sammeln, Tagesbriefing, Umsatz je Firma auswerten | Alle Kauf- und Verkaufsentscheidungen liegen bei Sven, der Agent führt nichts aus | 3 |
| **CEO** | Alles zu einem Morgenbericht bündeln, Prioritäten vorschlagen | Berichte zusammenfassen, Seite «Heute» füllen | Prioritäten setzen und Aufträge erteilen | 4 |
| **Reise** | Aufenthaltsübersicht, Zielvorschläge nach Svens Kriterien | Kalender auswerten, Tage pro Land zählen, Vorschläge sammeln | Buchungen | später |

Kein eigener Programmier-Agent. Entwickelt wird mit Claude Code. Später möglich: ein kleiner Wächter, der meldet, wenn ein Dienst ausfällt.

## 3. Gemeinsame Datenbank (Supabase)

Alle Tabellen mit Row Level Security, nur Sven hat Zugriff.

| Tabelle | Zweck | Wichtige Felder |
|---|---|---|
| `accounts` | Postfächer | provider (hostpoint, hostinger, hotmail, gmail), typ (imap/oauth), marke, aktiv |
| `messages` | Eingehende und ausgehende Mails | account_id, absender, betreff, text, sprache, kategorie, marke, zugewiesen_an (agent), status, erstellt_am |
| `drafts` | Antwortentwürfe | message_id, text_original, text_deutsch, status (offen / freigegeben / verworfen), erstellt_von |
| `tasks` | Aufgaben für Sven | titel, grund, quelle (agent), faellig_am, status, nur_wenn_sven_handeln_muss (bool) |
| `leads` | Potenzielle Kunden | marke, name, ort, land, kontakt, quelle, status, einwilligung (bool), notiz |
| `campaigns` | Kampagnen und Tests | marke, kanal, variante, budget, start, ende, kosten, anmeldungen, verkaeufe |
| `content_ideas` | Marketing-Ideen | marke, format, idee, caption, skript, status (neu / gewählt / verworfen / veröffentlicht) |
| `knowledge` | Wissensbasis je Marke | marke, thema, antwort, sprache, geprüft (bool) |
| `reports` | Berichte der Agenten | agent, zeitraum, inhalt, erstellt_am |
| `agent_log` | Protokoll aller Aktionen | agent, aktion, ziel, ergebnis, zeit |

Kategorien für `messages.kategorie`: `finanz`, `service`, `privat`, `geschäftlich`, `newsletter`, `unklar`.
Zuteilung: `finanz` → Finanz-Agent, `service` → Service-Agent, `privat` und `unklar` → Seite «Heute», `newsletter` → archiviert.

## 4. Agent 1: Mail

**Konten:** Hostpoint, Hostinger (je IMAP/SMTP), Hotmail und Gmail (OAuth, einmalige Freigabe durch Sven nötig).

**Ablauf (alle 5 Minuten):**
1. Neue Mails holen und in `messages` speichern.
2. Sprache erkennen, Kategorie und Marke bestimmen.
3. Zuteilen (siehe Regeln oben).
4. Bei Kategorie `service` oder `geschäftlich`: Entwurf in `drafts` anlegen, bei EN/ES mit deutscher Übersetzung.
5. Nur wenn Sven handeln muss: Eintrag in `tasks`.

**Grenzen:** Der Agent sendet nie selbst. Er löscht nichts endgültig. Unklare Mails gehen an Sven.

## 5. Agent 2: Service

- Wissensbasis je Marke (`knowledge`): Café Don Sombrerito (500-g-Beutel, Gratis-Paket, Versand, Mindestbestellung), Tamelo (Paketstufen, 14 Tage Test, Einrichtung, Abrechnung), Clave Suiza.
- Antwortet automatisch **nur**, wenn die Antwort eindeutig in der Wissensbasis steht. Sonst Entwurf an Sven.
- Nachfass-Sequenz Gratis-Paket (Don Sombrerito): nach 3 und 7 Tagen. Danach `task` für Sven, wenn eine Antwort kam.
- Nachfass-Sequenz Testphase (Tamelo): Tag 1, Tag 7, Tag 12 (vor Ablauf der 14 Tage).
- Antwortet in der Sprache des Kunden (DE/EN/ES). Andere Sprachen: Entwurf an Sven.

## 6. Agent 3: Marketing

**Wöchentlich (Montag):** Pro Marke 10 Ideen mit Format, Caption und Skript. Grundlage ist ein **Marken-Briefing** (Zielgruppe, Tonalität, bisherige Erfolge, feste Figuren wie Don Sombrerito und der Affe).

**Tamelo**
- Hebel: «Karte kostenlos prüfen» zeigt sofort das Umsatzpotenzial pro Monat.
- Anzeigenvarianten für Meta je Markt und Sprache, mit Rechenbeispiel (Gäste pro Tag × Mehrumsatz).
- Vorher-Nachher-Karten als Reel- und Post-Material.
- Auswertung: Anzeigenkosten, Anmeldungen zum Test, zahlende Kunden aus Digistore24.

**Café Don Sombrerito**
- A/B-Test: «1 kg (oder 2 × 500 g) mit Versand» gegen «Gratis-Paket». Zahlen in `campaigns`.
- B2B-Fokus: Restaurants mit einem einzigen Entscheider.
- Instagram-Serie mit animiertem Don Sombrerito und Affe, Ideen und Skripte.

**Lead-Recherche:** Restaurants mit öffentlichen Kontaktdaten in `leads` ablegen, mit Land und Quelle. Erstkontakte nur als Entwurf an Sven.

**Rechtlicher Hinweis:** Werbemails und Kaltkontakte sind je Land unterschiedlich geregelt (z. B. in DE/CH wird meist vorher eine Einwilligung verlangt). Darum gilt für alle Märkte: Erstkontakt nur mit Freigabe, Feld `einwilligung` pflegen. Das Prinzip sollte vor dem Start mit Fachperson geprüft werden.

## 7. Agent 4: Finanz

**Anlage:**
- Täglich: Kurse der Werte aus Svens Liste, relevante Nachrichten, Termine (Zahlen, Dividenden).
- Ausgabe: Ein Briefing, gebündelt und sortiert nach Dringlichkeit.
- Der Agent gibt keine Kauf- oder Verkaufsempfehlung als Auftrag aus und führt nie Trades aus. Sven entscheidet.

**Geschäftszahlen:** Umsatz je Firma (Don Sombrerito, Tamelo, Clave Suiza) aus Webshop und Digistore24, Wochenbericht.

**Finanzmails:** Kommen vom Mail-Agenten in den Eingang des Finanz-Agenten (Rechnungen, Bankmitteilungen, Steuer).

## 8. Agent 5: CEO

- Läuft täglich früh (Zeitzone Svens: America/Bahia_Banderas).
- Liest `reports`, `tasks`, offene `drafts`.
- Baut die Seite **«Heute»**: ① Muss ich selbst handeln? ② Entwürfe zur Freigabe ③ Zahlen von gestern ④ Eine Empfehlung für die wichtigste Handlung.
- Wird erst gebaut, wenn mindestens zwei andere Agenten laufen.

## 9. Technik

- Frontend: React + TypeScript + Vite + Tailwind (Seite «Heute», Freigabe-Liste).
- Backend: Supabase (Postgres, Auth, RLS, Cron).
- Agenten: Netlify-Funktionen bzw. Supabase-Edge-Funktionen, Claude API.
- Geheimnisse (Passwörter, API-Schlüssel): nur als Umgebungsvariablen, nie im Code.
- Jede Agent-Aktion wird in `agent_log` geschrieben.
- Keine Automatisierung privater WhatsApp-Nachrichten.

## 10. Reihenfolge

| Phase | Inhalt | Ergebnis |
|---|---|---|
| 1 | Datenbank, Mail-Agent, Seite «Heute» | Alle Postfächer an einem Ort, Entwürfe zur Freigabe |
| 2 | Service- und Marketing-Agent für Tamelo, dann Don Sombrerito | Nachfass-Sequenzen laufen, Wochen-Ideen kommen, A/B-Test startet |
| 3 | Finanz-Agent | Tagesbriefing zu Anlagen, Wochenbericht Umsatz |
| 4 | CEO-Agent | Ein Morgenbericht statt mehrerer |
| später | Reise-Agent | Überblick, wo Sven wann ist, Tage-Zähler, Zielvorschläge |

## 11. Offene Punkte

- OAuth-Freigabe für Gmail und Hotmail (macht Sven selbst).
- Liste der Postfächer mit Zuordnung zur Marke.
- Marken-Briefing je Marke (Zielgruppe, Ton, Figuren).
- Wissensbasis-Texte je Marke prüfen und freigeben.
- Welche Werte gehören ins Anlage-Briefing.
- Rechtliche Prüfung der Erstkontakte für die Zielmärkte.
