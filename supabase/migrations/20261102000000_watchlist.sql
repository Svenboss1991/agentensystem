-- Watchlist: Titel beobachten, ohne sie zu besitzen (Kurse, Analysten, Limits, Bewegungs-Warnungen).
alter table public.wertpapiere add column if not exists beobachten boolean not null default false;
alter table public.wertpapiere add column if not exists beobachtet_seit date;
alter table public.wertpapiere add column if not exists kurs_beim_hinzufuegen numeric;
