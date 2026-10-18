-- Sven darf die Strenge des Aufräumens selbst wählen (Spaltenrecht nochmals setzen, Schema neu laden).
grant update (auto_aufraeumen, aufraeum_strenge) on public.accounts to authenticated;
notify pgrst, 'reload schema';
