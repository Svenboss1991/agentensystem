-- Selbständiges Aufräumen: der Agent entscheidet je Absender und fragt Sven nur, wenn er unsicher ist.

alter table public.accounts add column auto_aufraeumen boolean not null default true;

-- Entscheidungen je Postfach, Kategorie und Absender (damit niemand zweimal gefragt wird).
create table public.aufraeum_absender (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  kategorie text not null,
  adresse text not null,
  name text,
  beispiele text[] not null default '{}',
  anzahl int not null default 0,                 -- in der Stichprobe
  urteil text not null check (urteil in ('muell', 'behalten', 'unsicher')),
  grund text,
  entschieden_von public.agent not null default 'mail',
  erstellt_am timestamptz not null default now(),
  aktualisiert_am timestamptz not null default now(),
  unique (account_id, kategorie, adresse)
);
create index aufraeum_unsicher_idx on public.aufraeum_absender (urteil) where urteil = 'unsicher';

-- Wann welche Kategorie zuletzt automatisch aufgeräumt wurde (reihum).
create table public.aufraeum_stand (
  account_id uuid not null references public.accounts (id) on delete cascade,
  kategorie text not null,
  zuletzt timestamptz,
  fehler text,
  primary key (account_id, kategorie)
);

alter table public.aufraeum_absender enable row level security;
alter table public.aufraeum_stand enable row level security;
create policy nur_sven on public.aufraeum_absender for all to authenticated using (public.ist_sven()) with check (public.ist_sven());
create policy nur_sven on public.aufraeum_stand for all to authenticated using (public.ist_sven()) with check (public.ist_sven());

-- Sven darf den Schalter «automatisch aufräumen» selbst umlegen (sonst sind accounts für ihn nur lesbar).
create policy sven_auto_aufraeumen on public.accounts for update to authenticated using (public.ist_sven()) with check (public.ist_sven());
revoke update on public.accounts from authenticated;
grant update (auto_aufraeumen) on public.accounts to authenticated;
