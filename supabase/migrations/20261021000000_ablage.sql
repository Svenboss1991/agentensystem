-- Ablage im Postfach: erledigte Mails wandern in Bereichs-Ordner
-- (Privat, Finanzen, Behörden & Recht, Tamelo, Don Sombrerito, Clave Suiza, Newsletter).

alter table public.messages
  add column abgelegt_am timestamptz,
  add column ablage_ordner text,
  add column ablage_fehler text;

create index messages_abzulegen_idx on public.messages (status)
  where abgelegt_am is null and richtung = 'eingehend';
