-- Konten und Karten (HSBC, Klar …): Saldo, Zins, Zahlungsfrist bei Kreditkarten. Fürs Nettovermögen und das Ziel.

create table public.konten (
  id uuid primary key default gen_random_uuid(),
  name text not null,                         -- z. B. «Cuenta Premier»
  institut text not null,                     -- z. B. «HSBC», «Klar»
  typ text not null default 'konto'
    check (typ in ('konto', 'sparen', 'festgeld', 'fonds', 'kreditkarte', 'kaution', 'sonstiges')),
  endziffern text,                            -- nur die letzten 4 Ziffern
  waehrung text not null default 'MXN',
  saldo numeric not null default 0,           -- Guthaben positiv, Schulden (Kreditkarte) negativ
  saldo_am date not null default current_date,
  zinssatz numeric,                           -- % pro Jahr
  zahlung_bis date,                           -- Kreditkarte: Zahlungsfrist
  zahlung_erinnert_fuer date,                 -- für welche Frist schon erinnert wurde
  notiz text,
  aktiv boolean not null default true,
  sortierung int not null default 0,
  erstellt_am timestamptz not null default now()
);

-- Verlauf der Salden (für Entwicklung des Vermögens).
create table public.konten_saldi (
  konto_id uuid not null references public.konten (id) on delete cascade,
  datum date not null,
  saldo numeric not null,
  primary key (konto_id, datum)
);

alter table public.konten enable row level security;
alter table public.konten_saldi enable row level security;
create policy nur_sven on public.konten for all to authenticated using (public.ist_sven()) with check (public.ist_sven());
create policy nur_sven on public.konten_saldi for all to authenticated using (public.ist_sven()) with check (public.ist_sven());
