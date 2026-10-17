-- Adressbuch (Firmen und Personen, mit Mails verknüpft) und Dokumentablage (Verträge, Policen …).

-- ─── Firmen ──────────────────────────────────────────────────────────────────
create table public.firmen (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  domains text[] not null default '{}',        -- z. B. {hsbc.com, hsbc.ch}: Mails dieser Domains gehören zur Firma
  bereich text not null default 'privat'
    check (bereich in ('privat', 'finanzen', 'behoerden', 'tamelo', 'don_sombrerito', 'clave_suiza')),
  telefon text,
  website text,
  adresse text,
  notiz text,
  erstellt_am timestamptz not null default now(),
  aktualisiert_am timestamptz not null default now()
);
create unique index firmen_name_idx on public.firmen (lower(name));
create index firmen_domains_idx on public.firmen using gin (domains);

-- ─── Personen ────────────────────────────────────────────────────────────────
create table public.kontakte (
  id uuid primary key default gen_random_uuid(),
  name text,
  email text,                                  -- immer klein geschrieben
  weitere_emails text[] not null default '{}',
  telefon text,
  mobil text,
  position text,
  firma_id uuid references public.firmen (id) on delete set null,
  notiz text,
  quelle public.agent not null default 'mail',
  letzter_kontakt timestamptz,
  erstellt_am timestamptz not null default now(),
  aktualisiert_am timestamptz not null default now()
);
create unique index kontakte_email_idx on public.kontakte (email) where email is not null;
create index kontakte_firma_idx on public.kontakte (firma_id);

alter table public.messages add column kontakt_id uuid references public.kontakte (id) on delete set null;
create index messages_kontakt_idx on public.messages (kontakt_id);

-- ─── Dokumente ───────────────────────────────────────────────────────────────
create table public.dokumente (
  id uuid primary key default gen_random_uuid(),
  titel text not null,
  typ text not null default 'sonstiges'
    check (typ in ('vertrag', 'police', 'rechnung', 'ausweis', 'bescheinigung', 'korrespondenz', 'sonstiges')),
  bereich text not null default 'privat'
    check (bereich in ('privat', 'finanzen', 'behoerden', 'tamelo', 'don_sombrerito', 'clave_suiza')),
  datei_pfad text not null,                    -- Pfad im Storage-Bucket «dokumente»
  datei_name text,
  groesse bigint,
  mime text,
  firma_id uuid references public.firmen (id) on delete set null,
  kontakt_id uuid references public.kontakte (id) on delete set null,
  akte_id uuid references public.akten (id) on delete set null,
  gueltig_bis date,                            -- Ablauf, z. B. Police oder Ausweis
  erinnern_am date,                            -- z. B. Kündigungsfrist: an diesem Tag wird eine Aufgabe erstellt
  erinnert_am timestamptz,
  notiz text,
  erstellt_am timestamptz not null default now()
);
create index dokumente_firma_idx on public.dokumente (firma_id);
create index dokumente_kontakt_idx on public.dokumente (kontakt_id);
create index dokumente_akte_idx on public.dokumente (akte_id);

alter table public.tasks add column dokument_id uuid references public.dokumente (id) on delete set null;

-- ─── Zugriff nur für Sven ────────────────────────────────────────────────────
alter table public.firmen enable row level security;
alter table public.kontakte enable row level security;
alter table public.dokumente enable row level security;
create policy nur_sven on public.firmen for all to authenticated using (public.ist_sven()) with check (public.ist_sven());
create policy nur_sven on public.kontakte for all to authenticated using (public.ist_sven()) with check (public.ist_sven());
create policy nur_sven on public.dokumente for all to authenticated using (public.ist_sven()) with check (public.ist_sven());

-- Privater Speicher für die Dateien; nur Sven darf lesen und schreiben.
insert into storage.buckets (id, name, public) values ('dokumente', 'dokumente', false) on conflict (id) do nothing;
create policy dokumente_nur_sven on storage.objects for all to authenticated
  using (bucket_id = 'dokumente' and public.ist_sven())
  with check (bucket_id = 'dokumente' and public.ist_sven());

-- ─── Bestehende Mails ins Adressbuch übernehmen ──────────────────────────────
create or replace function public.ist_freemail(domain text)
returns boolean
language sql
immutable
as $$
  select domain ~* '^(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|me|mac|gmx|web|bluewin|hispeed|sunrise|proton|protonmail|aol|t-online|freenet)\.'
$$;

insert into public.kontakte (name, email, letzter_kontakt)
select distinct on (lower(absender)) nullif(absender_name, ''), lower(absender), empfangen_am
  from public.messages
 where richtung = 'eingehend' and coalesce(kategorie::text, '') <> 'newsletter' and absender like '%@%'
 order by lower(absender), empfangen_am desc
on conflict (email) where email is not null do nothing;

insert into public.firmen (name, domains)
select distinct on (lower(split_part(d, '.', 1))) initcap(split_part(d, '.', 1)), array[d]
  from (select distinct split_part(email, '@', 2) as d from public.kontakte) x
 where d <> '' and not public.ist_freemail(d)
on conflict (lower(name)) do nothing;

update public.kontakte k set firma_id = f.id
  from public.firmen f
 where k.firma_id is null and split_part(k.email, '@', 2) = any (f.domains);

update public.messages m set kontakt_id = k.id
  from public.kontakte k
 where m.richtung = 'eingehend' and lower(m.absender) = k.email;
