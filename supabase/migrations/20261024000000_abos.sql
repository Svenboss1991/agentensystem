-- Abos: der Mail-Agent erfasst neue Abos, Testphasen, Verlängerungen, Preisänderungen und Kündigungen.

create table public.abos (
  id uuid primary key default gen_random_uuid(),
  anbieter text not null,
  produkt text,
  firma_id uuid references public.firmen (id) on delete set null,
  bereich text not null default 'privat'
    check (bereich in ('privat', 'finanzen', 'behoerden', 'tamelo', 'don_sombrerito', 'clave_suiza')),
  betrag numeric(12, 2),
  waehrung text default 'CHF',
  intervall text check (intervall in ('woechentlich', 'monatlich', 'quartalsweise', 'halbjaehrlich', 'jaehrlich', 'einmalig')),
  status text not null default 'aktiv' check (status in ('test', 'aktiv', 'gekuendigt', 'beendet')),
  beginn date,
  testphase_bis date,
  naechste_zahlung date,
  laufzeit_bis date,                -- Mindestlaufzeit / Vertragsende
  kuendigungsfrist text,            -- z. B. «1 Monat zum Laufzeitende»
  kuendbar_bis date,                -- letzter Tag, um rechtzeitig zu kündigen
  zahlungsmittel text,
  konto text,                       -- Login/Mail-Adresse beim Anbieter
  erinnern_am date,                 -- an diesem Tag entsteht eine Aufgabe
  erinnert_am timestamptz,
  notiz text,
  quelle_message_id uuid references public.messages (id) on delete set null,
  erstellt_am timestamptz not null default now(),
  aktualisiert_am timestamptz not null default now()
);
create index abos_status_idx on public.abos (status);

alter table public.messages add column abo_id uuid references public.abos (id) on delete set null;
alter table public.tasks add column abo_id uuid references public.abos (id) on delete set null;

alter table public.abos enable row level security;
create policy nur_sven on public.abos for all to authenticated using (public.ist_sven()) with check (public.ist_sven());
