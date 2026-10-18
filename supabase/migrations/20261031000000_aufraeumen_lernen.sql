-- Aufräumen, Version 3:
-- - Nicht nur Werbung, jeder Müll (alte Bestellungen, Lieferstatus, Hinweise ohne Wert) älter als 2 Wochen kommt weg.
-- - Strenge je Postfach: Gmail streng (kaum Wichtiges), die anderen normal.
-- - Der Agent lernt aus Svens Entscheiden (aufraeum_vorlage mit entschieden_am).
-- - Die bisher vorgelegten, noch offenen Mails werden mit den neuen Regeln nochmals beurteilt.

alter table public.accounts add column if not exists aufraeum_strenge text not null default 'normal'
  check (aufraeum_strenge in ('streng', 'normal', 'vorsichtig'));
update public.accounts set aufraeum_strenge = 'streng' where provider = 'gmail';
grant update (aufraeum_strenge) on public.accounts to authenticated;

delete from public.aufraeum_vorlage where status in ('offen', 'still') and entschieden_am is null;

update public.aufraeum_stand
set cursor = null, durchgang_fertig_am = null, gepruefte_mails = 0, fehler = null
where kategorie not like '%\_woche';
