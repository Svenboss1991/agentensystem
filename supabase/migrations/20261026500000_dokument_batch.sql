-- Dokument-Analyse über die Batch-Schnittstelle: Batch-ID je Dokument.
alter table public.dokumente add column analyse_batch text;
