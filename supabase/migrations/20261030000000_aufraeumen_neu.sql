-- Grosser Durchgang nochmals von vorne: Beim Weiterblättern wurden nach dem Wegräumen Mails übersprungen,
-- und Gmail-Mails mit der automatischen Markierung «wichtig» waren ausgenommen.
-- Bereits beurteilte Absender bleiben gespeichert; es werden nur die Mails nochmals durchgegangen.
update public.aufraeum_stand
set cursor = null, durchgang_fertig_am = null, gepruefte_mails = 0, fehler = null
where kategorie not like '%\_woche';
