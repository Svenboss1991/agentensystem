-- Aufräumen, Version 2:
-- - Jede Mail, die der Agent beim grossen Durchgang nicht löscht, wird Sven vorgelegt (aufraeum_vorlage).
-- - Werbung, die älter als 2 Wochen ist, kommt in den Papierkorb (auch von sonst wichtigen Absendern).
-- - Grosser Durchgang von vorne: vorher wurden beim Weiterblättern Mails übersprungen.

create table public.aufraeum_vorlage (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  kategorie text not null,
  mail_id text not null,                 -- Kennung beim Anbieter (Gmail-ID, Graph-ID, IMAP-UID)
  adresse text not null,
  name text,
  betreff text,
  datum timestamptz,
  -- offen = Sven entscheidet; jung = Werbung, noch keine 2 Wochen alt (wird später gelöscht);
  -- still = vom Agenten behalten, ohne Vorlage (wöchentlicher Lauf)
  status text not null default 'offen' check (status in ('offen', 'behalten', 'papierkorb', 'jung', 'still')),
  erstellt_am timestamptz not null default now(),
  entschieden_am timestamptz,
  unique (account_id, mail_id)
);
create index aufraeum_vorlage_offen_idx on public.aufraeum_vorlage (account_id, adresse) where status = 'offen';

alter table public.aufraeum_vorlage enable row level security;
create policy nur_sven on public.aufraeum_vorlage for all to authenticated using (public.ist_sven()) with check (public.ist_sven());

update public.aufraeum_stand
set cursor = null, durchgang_fertig_am = null, gepruefte_mails = 0, fehler = null
where kategorie not like '%\_woche';
