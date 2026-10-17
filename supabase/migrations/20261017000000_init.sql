-- Agentensystem, Phase 1: gemeinsame Datenbank aller Agenten.
-- Agenten schreiben mit dem Service-Role-Schlüssel (umgeht RLS).
-- Das Frontend nutzt den Anon-Schlüssel + Login; RLS lässt nur Sven durch.

-- ─── Besitzer ────────────────────────────────────────────────────────────────
-- Genau ein Eintrag: die auth.users-ID von Sven. Wird nach dem ersten Login gesetzt
-- (siehe README, Schritt «Besitzer festlegen»).
create table public.app_owner (
  user_id uuid primary key references auth.users (id) on delete cascade,
  erstellt_am timestamptz not null default now()
);
create unique index app_owner_nur_einer on public.app_owner ((true));

create or replace function public.ist_sven()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.app_owner where user_id = auth.uid());
$$;

-- ─── Aufzählungen ────────────────────────────────────────────────────────────
create type public.marke as enum ('tamelo', 'don_sombrerito', 'clave_suiza', 'keine');
create type public.agent as enum ('mail', 'service', 'marketing', 'finanz', 'ceo', 'reise', 'sven');
create type public.kategorie as enum ('finanz', 'service', 'privat', 'geschäftlich', 'newsletter', 'unklar');
create type public.sprache as enum ('de', 'en', 'es', 'andere');

-- ─── accounts ────────────────────────────────────────────────────────────────
-- Keine Passwörter oder Tokens hier. secret_ref verweist auf Umgebungsvariablen:
--   IMAP:  MAIL_<secret_ref>_PASSWORD
--   OAuth: MAIL_<secret_ref>_REFRESH_TOKEN
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('hostpoint', 'hostinger', 'hotmail', 'gmail')),
  typ text not null check (typ in ('imap', 'oauth')),
  adresse text not null unique,
  anzeigename text,
  marke public.marke not null default 'keine',
  aktiv boolean not null default true,
  secret_ref text not null,
  imap_host text,
  imap_port int default 993,
  smtp_host text,
  smtp_port int default 465,
  benutzer text,
  archiv_ordner text default 'Archive',
  -- Synchronisationsstand (vom Mail-Agenten gepflegt)
  sync_uidvalidity bigint,
  sync_letzte_uid bigint,
  sync_seit timestamptz,
  sync_zuletzt timestamptz,
  sync_fehler text,
  erstellt_am timestamptz not null default now(),
  check (typ <> 'imap' or (imap_host is not null and smtp_host is not null))
);

-- ─── messages ────────────────────────────────────────────────────────────────
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  richtung text not null default 'eingehend' check (richtung in ('eingehend', 'ausgehend')),
  extern_id text not null,            -- IMAP-UID / Gmail-ID / Graph-ID
  message_id_header text,             -- RFC-Message-ID, für Antworten im selben Faden
  thread_ref text,                    -- Gmail threadId / Graph conversationId
  absender text not null,
  absender_name text,
  empfaenger text,
  betreff text,
  text text,
  empfangen_am timestamptz,
  sprache public.sprache,
  kategorie public.kategorie,
  marke public.marke,
  zusammenfassung text,               -- 1–2 Sätze auf Deutsch
  zugewiesen_an public.agent,
  status text not null default 'neu'
    check (status in ('neu', 'in_arbeit', 'verarbeitet', 'archiviert', 'erledigt', 'fehler')),
  fehler text,
  bearbeitet_am timestamptz,
  erstellt_am timestamptz not null default now(),
  unique (account_id, extern_id)
);
create index messages_status_idx on public.messages (status);
create index messages_zuweisung_idx on public.messages (zugewiesen_an, status);
create index messages_empfangen_idx on public.messages (empfangen_am desc);

-- ─── drafts ──────────────────────────────────────────────────────────────────
create table public.drafts (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages (id) on delete cascade,
  text_original text not null,
  text_deutsch text,                  -- nur bei EN/ES gefüllt
  sprache public.sprache,
  status text not null default 'offen'
    check (status in ('offen', 'freigegeben', 'gesendet', 'verworfen', 'fehler')),
  erstellt_von public.agent not null,
  begruendung text,                   -- warum der Agent so antwortet / was unsicher ist
  fehler text,
  freigegeben_am timestamptz,
  gesendet_am timestamptz,
  erstellt_am timestamptz not null default now()
);
create index drafts_status_idx on public.drafts (status);
create unique index drafts_ein_offener_pro_mail on public.drafts (message_id) where status = 'offen';

-- ─── tasks ───────────────────────────────────────────────────────────────────
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  titel text not null,
  grund text,
  quelle public.agent not null,
  message_id uuid references public.messages (id) on delete set null,
  faellig_am date,
  status text not null default 'offen' check (status in ('offen', 'erledigt', 'verworfen')),
  nur_wenn_sven_handeln_muss boolean not null default true,
  erstellt_am timestamptz not null default now(),
  erledigt_am timestamptz
);
create index tasks_status_idx on public.tasks (status);

-- ─── leads ───────────────────────────────────────────────────────────────────
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  marke public.marke not null,
  name text not null,
  ort text,
  land text,
  kontakt text,
  quelle text,
  status text not null default 'neu'
    check (status in ('neu', 'entwurf', 'kontaktiert', 'interessiert', 'kunde', 'abgelehnt')),
  einwilligung boolean not null default false,
  notiz text,
  erstellt_am timestamptz not null default now()
);

-- ─── campaigns ───────────────────────────────────────────────────────────────
create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  marke public.marke not null,
  kanal text not null,
  variante text,
  budget numeric(12, 2),
  start date,
  ende date,
  kosten numeric(12, 2) default 0,
  anmeldungen int default 0,
  verkaeufe int default 0,
  erstellt_am timestamptz not null default now()
);

-- ─── content_ideas ───────────────────────────────────────────────────────────
create table public.content_ideas (
  id uuid primary key default gen_random_uuid(),
  marke public.marke not null,
  format text,
  idee text not null,
  caption text,
  skript text,
  status text not null default 'neu' check (status in ('neu', 'gewählt', 'verworfen', 'veröffentlicht')),
  erstellt_am timestamptz not null default now()
);

-- ─── knowledge ───────────────────────────────────────────────────────────────
create table public.knowledge (
  id uuid primary key default gen_random_uuid(),
  marke public.marke not null,
  thema text not null,
  antwort text not null,
  sprache public.sprache not null default 'de',
  geprueft boolean not null default false,  -- nur geprüfte Einträge dürfen Agenten verwenden
  erstellt_am timestamptz not null default now(),
  geaendert_am timestamptz not null default now()
);
create index knowledge_marke_idx on public.knowledge (marke) where geprueft;

-- ─── reports ─────────────────────────────────────────────────────────────────
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  agent public.agent not null,
  zeitraum text not null,
  inhalt jsonb not null,
  erstellt_am timestamptz not null default now()
);

-- ─── agent_log ───────────────────────────────────────────────────────────────
create table public.agent_log (
  id bigint generated always as identity primary key,
  agent public.agent not null,
  aktion text not null,
  ziel text,
  ergebnis text,
  zeit timestamptz not null default now()
);
create index agent_log_zeit_idx on public.agent_log (zeit desc);

-- ─── Row Level Security: nur Sven ────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'accounts', 'messages', 'drafts', 'tasks', 'leads', 'campaigns',
    'content_ideas', 'knowledge', 'reports', 'agent_log'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy nur_sven on public.%I for all to authenticated using (public.ist_sven()) with check (public.ist_sven())',
      t
    );
  end loop;
end $$;

alter table public.app_owner enable row level security;
create policy sven_sieht_sich on public.app_owner for select to authenticated using (user_id = auth.uid());

-- Das Protokoll ist für Sven nur lesbar.
drop policy nur_sven on public.agent_log;
create policy nur_sven_lesen on public.agent_log for select to authenticated using (public.ist_sven());

-- Zugangsdaten-Verweise sind lesbar, aber nur über SQL/Service-Role änderbar.
drop policy nur_sven on public.accounts;
create policy nur_sven_lesen on public.accounts for select to authenticated using (public.ist_sven());

revoke all on all tables in schema public from anon;
revoke execute on function public.ist_sven() from anon;
