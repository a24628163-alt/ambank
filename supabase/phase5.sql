-- AmBank Phase 5 (launch readiness). Run after phase4.sql.

-- 1) Launch switch. While dev_mode = 'true': new accounts get simulated test funds and self-service deposits work.
--    To go live:  update public.app_settings set value = 'false' where key = 'dev_mode';
create table public.app_settings (key text primary key, value text not null);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;
insert into public.app_settings values ('dev_mode', 'true');
create function public._dev() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select value = 'true' from app_settings where key = 'dev_mode'), false) $$;
revoke execute on function public._dev() from public, anon, authenticated;

-- Signup trigger: test funds only in dev mode; retries if a random account number collides.
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare dev boolean := _dev();
begin
  for i in 1..5 loop
    begin
      insert into public.profiles(user_id, full_name, email, phone_number, account_number, checking_balance, savings_balance)
      values (new.id, coalesce(new.raw_user_meta_data->>'full_name','Customer'), new.email, new.raw_user_meta_data->>'phone',
              '10' || lpad(floor(random()*1e8)::text, 8, '0'), case when dev then 1000 else 0 end, case when dev then 500 else 0 end);
      return new;
    exception when unique_violation then null;
    end;
  end loop;
  raise exception 'Could not allocate an account number';
end $$;

create or replace function public.deposit(p_dest text, p_amount numeric, p_method text, p_key uuid) returns text
language plpgsql security definer set search_path = public as $$
declare p public.profiles; ref text := 'AMB-' || replace(p_key::text,'-','');
begin
  if not _dev() then raise exception 'Self-service deposits are disabled. Contact support.'; end if;
  if p_dest not in ('checking','savings') then raise exception 'Choose a destination account'; end if;
  if p_method not in ('card','bank_transfer','cash') then raise exception 'Choose a funding method'; end if;
  if p_amount is null or p_amount < 0.01 or p_amount > 10000 then raise exception 'Deposits must be between $0.01 and $10,000'; end if;
  select * into p from profiles where user_id = auth.uid() for update;
  if not found then raise exception 'Not signed in'; end if;
  if p.account_status = 'suspended' then raise exception 'Account is suspended. Contact support.'; end if;
  update profiles set checking_balance = checking_balance + case p_dest when 'checking' then p_amount else 0 end,
                      savings_balance  = savings_balance  + case p_dest when 'savings'  then p_amount else 0 end
  where user_id = p.user_id;
  insert into transactions(user_id, transaction_type, amount, description, reference_number)
  values (p.user_id, 'deposit', p_amount, 'Simulated deposit to ' || p_dest || ' (' || replace(p_method,'_',' ') || ')', ref);
  return ref;
end $$;

-- 2) Staff must pass TOTP two-step verification (JWT assurance level aal2), enforced in the database, not the UI.
create or replace function public._need(roles text[]) returns uuid language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or coalesce(admin_role(), '') <> all(roles) or coalesce(auth.jwt()->>'aal', '') <> 'aal2' then
    raise exception 'Not authorized'; end if;
  return auth.uid();
end $$;
create function public.staff_ok() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from admin_users where user_id = auth.uid()) and coalesce(auth.jwt()->>'aal', '') = 'aal2' $$;
grant execute on function public.staff_ok() to authenticated;
drop policy "staff read audit" on public.audit_logs;
create policy "staff read audit" on public.audit_logs for select using (staff_ok());
drop policy "own or staff tickets" on public.support_tickets;
create policy "own or staff tickets" on public.support_tickets for select using (user_id = auth.uid() or staff_ok());
drop policy "own or staff replies" on public.ticket_replies;
create policy "own or staff replies" on public.ticket_replies for select using (exists (
  select 1 from public.support_tickets t where t.ticket_id = ticket_replies.ticket_id and (t.user_id = auth.uid() or staff_ok())));
