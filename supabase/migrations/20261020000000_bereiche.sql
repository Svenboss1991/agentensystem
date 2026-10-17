-- Ordnung nach Bereichen (Privat, Finanzen, Behörden & Recht, Tamelo, Don Sombrerito, Clave Suiza)
-- und Zusammenführen von Akten.

alter table public.akten
  add column bereich text not null default 'privat'
    check (bereich in ('privat', 'finanzen', 'behoerden', 'tamelo', 'don_sombrerito', 'clave_suiza')),
  add column zusammengefuehrt_in uuid references public.akten (id) on delete set null;

update public.akten set bereich = marke::text where marke in ('tamelo', 'don_sombrerito', 'clave_suiza');

-- Zusammenführen: Mails, Einträge und Aufgaben wandern in die Ziel-Akte; die Quelle wird «verworfen».
create or replace function public.akten_zusammenfuehren(quell_akte uuid, ziel_akte uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  q_nummer text;
  z_nummer text;
begin
  if quell_akte = ziel_akte then
    raise exception 'Quelle und Ziel sind dieselbe Akte';
  end if;
  select nummer into q_nummer from akten where id = quell_akte;
  select nummer into z_nummer from akten where id = ziel_akte;
  if q_nummer is null or z_nummer is null then
    raise exception 'Akte nicht gefunden';
  end if;

  update messages set akte_id = ziel_akte where akte_id = quell_akte;
  update akte_eintraege set akte_id = ziel_akte where akte_id = quell_akte;
  update tasks set akte_id = ziel_akte where akte_id = quell_akte;
  update akten
     set status = 'verworfen', zusammengefuehrt_in = ziel_akte, erledigt_am = now()
   where id = quell_akte;
  update akten set zuletzt_aktiv = now() where id = ziel_akte;
  insert into akte_eintraege (akte_id, typ, text, von)
    values (ziel_akte, 'ereignis', q_nummer || ' wurde in diese Akte zusammengeführt', 'sven');
end $$;

revoke execute on function public.akten_zusammenfuehren(uuid, uuid) from anon;
