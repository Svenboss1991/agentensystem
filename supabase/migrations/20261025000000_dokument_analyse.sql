-- Analyse von Policen und Verträgen durch Claude (Deckung, Ausschlüsse, Prämie, Fristen).

alter table public.dokumente
  add column analyse jsonb,
  add column analyse_status text check (analyse_status in ('laeuft', 'fertig', 'fehler')),
  add column analyse_fehler text,
  add column analysiert_am timestamptz;
