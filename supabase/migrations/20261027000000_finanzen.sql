-- Finanz-Agent, Teil 1: Depot (HSBC-Import), echte Rendite, Limits, Kennzahlen/Berichte, Ziel.

create table public.wertpapiere (
  id uuid primary key default gen_random_uuid(),
  emisora text not null unique,               -- Name beim Broker, z. B. «ASUR B»
  name text,
  typ text not null default 'aktie' check (typ in ('aktie', 'etf', 'fonds', 'note', 'geldmarkt', 'sonstiges')),
  waehrung text not null default 'MXN',
  ticker text,                                -- für Kurse von Yahoo Finance, z. B. «ASURB.MX»
  kurs numeric,
  kurs_vortag numeric,
  kurs_am timestamptz,
  bericht jsonb,                              -- Kennzahlen, Analysten, Dividenden, News, Steuern (Claude mit Websuche)
  bericht_am timestamptz,
  bericht_fehler text,
  warnung_am date,                            -- letzte Warnung wegen grosser Tagesbewegung
  notiz text,
  erstellt_am timestamptz not null default now()
);

create table public.depot_transaktionen (
  id uuid primary key default gen_random_uuid(),
  depot text not null default 'HSBC',
  datum date not null,
  liquidation date,
  folio text not null default '',
  konzept text not null,
  typ text not null
    check (typ in ('kauf', 'verkauf', 'dividende', 'einzahlung', 'auszahlung', 'reporto_start', 'reporto_ende', 'sonstiges')),
  emisora text not null default '',
  wertpapier_id uuid references public.wertpapiere (id) on delete set null,
  stueck numeric,
  kurs numeric,
  betrag numeric,                             -- Importe Neto
  brutto numeric,
  kommission numeric,
  iva numeric,
  isr numeric,
  zins numeric,                               -- Reporto: Zins nach ISR
  zinssatz numeric,
  quelle text not null default 'import' check (quelle in ('import', 'sven')),
  erstellt_am timestamptz not null default now()
);
alter table public.depot_transaktionen add constraint depot_tx_eindeutig unique (depot, folio, konzept, emisora, datum);
create index depot_tx_papier_idx on public.depot_transaktionen (wertpapier_id, datum);

-- Bestand laut Bank (aus «Posiciones»), je Import ein Stand.
create table public.depot_positionen (
  id uuid primary key default gen_random_uuid(),
  depot text not null default 'HSBC',
  wertpapier_id uuid not null references public.wertpapiere (id) on delete cascade,
  stand_am date not null,
  stueck numeric not null,
  kurs numeric,
  wert numeric,
  kosten_bank numeric,
  kosten_durchschnitt numeric,
  erstellt_am timestamptz not null default now(),
  unique (depot, wertpapier_id, stand_am)
);

-- Offene Aufträge bei der Bank (aus «Órdenes Vigentes»).
create table public.depot_orders (
  id uuid primary key default gen_random_uuid(),
  depot text not null default 'HSBC',
  folio text not null,
  datum date,
  art text not null check (art in ('kauf', 'verkauf')),
  emisora text,
  wertpapier_id uuid references public.wertpapiere (id) on delete set null,
  stueck numeric,
  kurs numeric,
  gueltig_bis date,
  status text,
  stand_am date not null default current_date,
  unique (depot, folio)
);

-- Eigene Kauf-/Verkaufslimits: der Agent meldet, wenn der Kurs sie erreicht.
create table public.kurs_limits (
  id uuid primary key default gen_random_uuid(),
  wertpapier_id uuid not null references public.wertpapiere (id) on delete cascade,
  art text not null check (art in ('kauf', 'verkauf')),
  kurs numeric not null,
  stueck numeric,
  notiz text,
  aktiv boolean not null default true,
  ausgeloest_am timestamptz,
  erstellt_am timestamptz not null default now()
);

create table public.finanz_ziele (
  id uuid primary key default gen_random_uuid(),
  titel text not null,
  betrag numeric not null,
  waehrung text not null default 'MXN',
  bis date not null,
  aktiv boolean not null default true,
  erstellt_am timestamptz not null default now()
);
insert into public.finanz_ziele (titel, betrag, waehrung, bis) values ('10 Mio. MXN', 10000000, 'MXN', '2031-09-11');

-- Zustand der Agenten (z. B. laufender Batch für Berichte).
create table public.agent_stand (
  schluessel text primary key,
  wert jsonb,
  aktualisiert_am timestamptz not null default now()
);

alter table public.tasks add column wertpapier_id uuid references public.wertpapiere (id) on delete set null;

do $$
declare t text;
begin
  foreach t in array array['wertpapiere', 'depot_transaktionen', 'depot_positionen', 'depot_orders', 'kurs_limits', 'finanz_ziele', 'agent_stand'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy nur_sven on public.%I for all to authenticated using (public.ist_sven()) with check (public.ist_sven())',
      t
    );
  end loop;
end $$;
