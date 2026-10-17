-- Phase 1b: Pendenzen (Wiedervorlage), gesendete Mails, OAuth-Verbindung über die Seite.

-- ─── Gesendete Mails mitlesen ────────────────────────────────────────────────
alter table public.accounts
  add column sync_sent_uidvalidity bigint,
  add column sync_sent_letzte_uid bigint,
  add column sync_sent_seit timestamptz;

-- Für das Erkennen von Antworten im selben Faden.
alter table public.messages
  add column in_reply_to text,
  add column references_header text;
create index messages_message_id_idx on public.messages (message_id_header);

-- ─── Pendenzen: Dinge, auf die Sven wartet ───────────────────────────────────
create table public.pendenzen (
  id uuid primary key default gen_random_uuid(),
  titel text not null,                 -- z. B. «Datenauskunft Aeroméxico»
  gegenpartei text,                    -- Name/Firma
  gegenpartei_adresse text,            -- Mail-Adresse, für das Zuordnen von Antworten
  worauf text,                         -- was erwartet wird
  seit date not null default current_date,
  wiedervorlage_am date not null,
  status text not null default 'offen' check (status in ('offen', 'erledigt', 'verworfen')),
  quelle public.agent not null default 'mail',
  message_id uuid references public.messages (id) on delete set null,          -- Mail, die die Pendenz ausgelöst hat
  antwort_message_id uuid references public.messages (id) on delete set null,  -- Mail, die sie erledigt hat
  thread_message_ids text[] not null default '{}',                              -- RFC-Message-IDs des Fadens
  notiz text,
  erinnert_am timestamptz,             -- wann die Nachfass-Aufgabe erstellt wurde
  erstellt_am timestamptz not null default now(),
  erledigt_am timestamptz
);
create index pendenzen_offen_idx on public.pendenzen (wiedervorlage_am) where status = 'offen';

alter table public.tasks add column pendenz_id uuid references public.pendenzen (id) on delete set null;

alter table public.pendenzen enable row level security;
create policy nur_sven on public.pendenzen for all to authenticated using (public.ist_sven()) with check (public.ist_sven());

-- ─── OAuth-Tokens (Gmail, Hotmail) ───────────────────────────────────────────
-- Microsoft und Google erneuern das Refresh-Token laufend; darum liegt es hier statt in
-- einer Umgebungsvariable. RLS ohne Richtlinie: nur der Service-Role-Schlüssel der Agenten
-- kommt heran, auch Svens Login nicht.
create table public.oauth_tokens (
  account_id uuid primary key references public.accounts (id) on delete cascade,
  refresh_token text not null,
  aktualisiert_am timestamptz not null default now()
);
alter table public.oauth_tokens enable row level security;
revoke all on public.oauth_tokens from anon, authenticated;
