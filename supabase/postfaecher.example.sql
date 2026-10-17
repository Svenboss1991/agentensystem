-- Vorlage: Postfächer eintragen (im Supabase SQL-Editor ausführen).
-- Adressen, Hosts und Marken anpassen. Passwörter/Tokens NICHT hier, sondern als
-- Umgebungsvariable MAIL_<secret_ref>_PASSWORD bzw. MAIL_<secret_ref>_REFRESH_TOKEN in Netlify.

insert into public.accounts (provider, typ, adresse, anzeigename, marke, secret_ref, imap_host, smtp_host, archiv_ordner) values
  ('hostpoint', 'imap', 'info@donsombrerito.ch', 'Sven – Café Don Sombrerito', 'don_sombrerito', 'HOSTPOINT_INFO',
   'imap.mail.hostpoint.ch', 'asmtp.mail.hostpoint.ch', 'Archive'),
  ('hostinger', 'imap', 'hola@tamelo.com', 'Sven – Tamelo', 'tamelo', 'HOSTINGER_INFO',
   'imap.hostinger.com', 'smtp.hostinger.com', 'INBOX.Archive');

insert into public.accounts (provider, typ, adresse, anzeigename, marke, secret_ref) values
  ('gmail',   'oauth', 'sven@gmail.com',   'Sven', 'keine', 'GMAIL_SVEN'),
  ('hotmail', 'oauth', 'sven@hotmail.com', 'Sven', 'keine', 'HOTMAIL_SVEN');
