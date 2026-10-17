-- Akten statt Pendenzen: jede Angelegenheit bekommt eine Fallnummer und einen Verlauf.

alter table public.pendenzen rename to akten;
alter index public.pendenzen_offen_idx rename to akten_offen_idx;

alter table public.akten
  add column nummer text unique,
  add column am_zug text not null default 'gegenseite' check (am_zug in ('gegenseite', 'sven')),
  add column marke public.marke,
  add column zuletzt_aktiv timestamptz not null default now(),
  alter column wiedervorlage_am drop not null;

-- Fallnummer F-<Jahr>-<laufende Nummer>, pro Jahr ab 0001.
create or replace function public.akten_nummer()
returns trigger
language plpgsql
as $$
declare
  jahr text := to_char(coalesce(new.erstellt_am, now()), 'YYYY');
  n int;
begin
  if new.nummer is null then
    select coalesce(max(split_part(nummer, '-', 3)::int), 0) + 1 into n
      from public.akten where nummer like 'F-' || jahr || '-%';
    new.nummer := 'F-' || jahr || '-' || lpad(n::text, 4, '0');
  end if;
  return new;
end $$;

create trigger akten_nummer before insert on public.akten
  for each row execute function public.akten_nummer();

-- Bestehenden Pendenzen der Reihe nach eine Nummer geben.
do $$
declare r record; jahr text; n int;
begin
  for r in select id, erstellt_am from public.akten where nummer is null order by erstellt_am loop
    jahr := to_char(r.erstellt_am, 'YYYY');
    select coalesce(max(split_part(nummer, '-', 3)::int), 0) + 1 into n from public.akten where nummer like 'F-' || jahr || '-%';
    update public.akten set nummer = 'F-' || jahr || '-' || lpad(n::text, 4, '0') where id = r.id;
  end loop;
end $$;
alter table public.akten alter column nummer set not null;

alter table public.tasks rename column pendenz_id to akte_id;

-- Jede Mail kann zu einer Akte gehören.
alter table public.messages add column akte_id uuid references public.akten (id) on delete set null;
create index messages_akte_idx on public.messages (akte_id);
create index messages_thread_idx on public.messages (thread_ref);
update public.messages m set akte_id = a.id
  from public.akten a where m.id in (a.message_id, a.antwort_message_id);

-- Notizen und Ereignisse im Verlauf einer Akte (Mails kommen aus messages).
create table public.akte_eintraege (
  id uuid primary key default gen_random_uuid(),
  akte_id uuid not null references public.akten (id) on delete cascade,
  typ text not null default 'notiz' check (typ in ('notiz', 'ereignis')),
  text text not null,
  von public.agent not null default 'sven',
  erstellt_am timestamptz not null default now()
);
create index akte_eintraege_akte_idx on public.akte_eintraege (akte_id, erstellt_am);
alter table public.akte_eintraege enable row level security;
create policy nur_sven on public.akte_eintraege for all to authenticated using (public.ist_sven()) with check (public.ist_sven());
