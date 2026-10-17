-- Aufräumen geht seitenweise durch alle Mails einer Kategorie (alle Jahre) und merkt sich die Stelle.

alter table public.aufraeum_stand
  add column cursor text,                       -- wo der Durchgang steht (Seiten-Token bzw. UID)
  add column gepruefte_mails int not null default 0,
  add column durchgang_fertig_am timestamptz;   -- letzter vollständiger Durchgang
