-- AmBank: complete database setup. Run once in the Supabase SQL editor (new project).
-- Order: schema, then phases 2 to 7. Simulated funds only.

-- ==================== schema.sql ====================
-- AmBank schema (Phase 1). Run in Supabase SQL editor. SIMULATED FUNDS ONLY.
create table public.profiles (
  user_id uuid primary key references auth.users on delete cascade,
  full_name text not null, email text not null, phone_number text,
  account_number text unique not null,
  checking_balance numeric(14,2) not null default 0 check (checking_balance >= 0),
  savings_balance  numeric(14,2) not null default 0 check (savings_balance  >= 0),
  account_status text not null default 'active' check (account_status in ('active','frozen','suspended')),
  created_at timestamptz not null default now());
create table public.transactions (
  transaction_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  transaction_type text not null, amount numeric(14,2) not null check (amount > 0),
  currency text not null default 'USD', description text,
  status text not null default 'completed',
  reference_number text unique not null, created_at timestamptz not null default now());

alter table public.profiles enable row level security;
alter table public.transactions enable row level security;
create policy "own profile read" on public.profiles for select using (auth.uid() = user_id);
create policy "own tx read" on public.transactions for select using (auth.uid() = user_id);
-- Clients can never write balances or transactions directly:
revoke insert, update, delete on public.profiles, public.transactions from anon, authenticated;

-- Create profile on signup (dev: starts with simulated test funds)
create function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(user_id, full_name, email, phone_number, account_number, checking_balance, savings_balance)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name','Customer'), new.email,
          new.raw_user_meta_data->>'phone', '10' || lpad(floor(random()*1e8)::text, 8, '0'), 1000, 500);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Atomic, server-validated move between own accounts. p_key = client UUID (blocks duplicate submits).
create function public.move_funds(p_from text, p_to text, p_amount numeric, p_key uuid) returns void
language plpgsql security definer set search_path = public as $$
declare p public.profiles; bal numeric;
begin
  if p_from not in ('checking','savings') or p_to not in ('checking','savings') or p_from = p_to then raise exception 'Choose two different accounts'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount greater than zero'; end if;
  select * into p from public.profiles where user_id = auth.uid() for update;
  if not found then raise exception 'Not signed in'; end if;
  if p.account_status <> 'active' then raise exception 'Account is %. Transfers are blocked; contact support.', p.account_status; end if;
  bal := case p_from when 'checking' then p.checking_balance else p.savings_balance end;
  if bal < p_amount then raise exception 'Insufficient funds'; end if;
  update public.profiles set
    checking_balance = checking_balance + case p_to when 'checking' then p_amount else -p_amount end,
    savings_balance  = savings_balance  + case p_to when 'savings'  then p_amount else -p_amount end
  where user_id = p.user_id;
  insert into public.transactions(user_id, transaction_type, amount, description, reference_number)
  values (p.user_id, 'move_funds', p_amount, 'Moved from ' || p_from || ' to ' || p_to, 'AMB-' || replace(p_key::text,'-',''));
end $$;
grant execute on function public.move_funds(text,text,numeric,uuid) to authenticated;

-- ==================== phase2.sql ====================
-- AmBank Phase 2. Run after schema.sql. SIMULATED FUNDS ONLY.
create extension if not exists pgcrypto with schema extensions;

-- PIN hashes live where clients can never read them: RLS on, no policies, no grants.
create table public.transaction_security (
  user_id uuid primary key references public.profiles on delete cascade,
  pin_hash text not null, failed_attempts int not null default 0,
  locked_until timestamptz, updated_at timestamptz not null default now());
alter table public.transaction_security enable row level security;
revoke all on public.transaction_security from anon, authenticated;

create function public.has_pin() returns boolean language sql security definer set search_path = public as $$
  select exists (select 1 from transaction_security where user_id = auth.uid()) $$;

-- First-time PIN only. Resets are an admin-initiated flow (Phase 3).
create function public.set_pin(p_pin text) returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if p_pin !~ '^(\d{4}|\d{6})$' then raise exception 'PIN must be 4 or 6 digits'; end if;
  if exists (select 1 from transaction_security where user_id = auth.uid()) then
    raise exception 'A PIN already exists. Contact support to reset it.'; end if;
  insert into transaction_security(user_id, pin_hash) values (auth.uid(), crypt(p_pin, gen_salt('bf', 10)));
end $$;

-- Returns "Jane D." so senders can confirm the payee without exposing full names.
create function public.lookup_recipient(p_account text) returns text language sql security definer set search_path = public as $$
  select regexp_replace(full_name, '^(\S+)\s+.*?(\S)\S*$', '\1 \2.') from profiles
  where account_number = p_account and user_id <> auth.uid() and account_status <> 'suspended' $$;

create function public.deposit(p_dest text, p_amount numeric, p_method text, p_key uuid) returns text
language plpgsql security definer set search_path = public as $$
declare p public.profiles; ref text := 'AMB-' || replace(p_key::text,'-','');
begin
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

-- Wrong-PIN results are RETURNED, not raised, so the attempt counter survives the transaction.
create function public.transfer_funds(p_to text, p_amount numeric, p_desc text, p_pin text, p_key uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare me public.profiles; r public.profiles; s public.transaction_security;
        ref text := 'AMB-' || replace(p_key::text,'-',''); note text := left(trim(coalesce(p_desc,'')), 100);
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if p_amount is null or p_amount < 0.01 then raise exception 'Enter an amount of at least $0.01'; end if;
  select * into r from profiles where account_number = p_to;
  if not found or r.user_id = auth.uid() then raise exception 'Recipient account not found'; end if;
  perform 1 from profiles where user_id in (auth.uid(), r.user_id) order by user_id for update;  -- fixed lock order: no deadlocks
  select * into me from profiles where user_id = auth.uid();
  select * into r  from profiles where user_id = r.user_id;
  if me.account_status <> 'active' then raise exception 'Account is %. Transfers are blocked; contact support.', me.account_status; end if;
  if r.account_status = 'suspended' then raise exception 'Recipient account cannot receive funds'; end if;
  select * into s from transaction_security where user_id = me.user_id for update;
  if not found then raise exception 'Set a transaction PIN first'; end if;
  if s.locked_until is not null and s.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong PINs. Try again in ' || ceil(extract(epoch from s.locked_until - now())/60)::int || ' minutes.'); end if;
  if s.pin_hash <> crypt(p_pin, s.pin_hash) then
    update transaction_security set failed_attempts = case when failed_attempts + 1 >= 5 then 0 else failed_attempts + 1 end,
      locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' end, updated_at = now() where user_id = me.user_id;
    return jsonb_build_object('ok', false, 'error', case when s.failed_attempts + 1 >= 5 then 'Too many wrong PINs. Transfers are locked for 15 minutes.'
      else 'Incorrect PIN. ' || (5 - s.failed_attempts - 1) || ' attempts left.' end);
  end if;
  update transaction_security set failed_attempts = 0, locked_until = null where user_id = me.user_id;
  if me.checking_balance < p_amount then raise exception 'Insufficient funds in checking'; end if;
  update profiles set checking_balance = checking_balance - p_amount where user_id = me.user_id;
  update profiles set checking_balance = checking_balance + p_amount where user_id = r.user_id;
  insert into transactions(user_id, transaction_type, amount, description, reference_number) values
    (me.user_id, 'transfer_out', p_amount, 'Transfer to ' || p_to || case when note <> '' then ': ' || note else '' end, ref || '-O'),
    (r.user_id,  'transfer_in',  p_amount, 'Transfer from ' || me.account_number || case when note <> '' then ': ' || note else '' end, ref || '-I');
  return jsonb_build_object('ok', true, 'ref', ref);
end $$;
grant execute on function public.has_pin(), public.set_pin(text), public.lookup_recipient(text),
  public.deposit(text,numeric,text,uuid), public.transfer_funds(text,numeric,text,text,uuid) to authenticated;

-- ==================== phase3.sql ====================
-- AmBank Phase 3. Run after phase2.sql. SIMULATED FUNDS ONLY.
-- Lock down function execution: only explicitly granted roles can call functions.
revoke execute on all functions in schema public from public, anon;

create table public.admin_users (user_id uuid primary key references auth.users on delete cascade,
  role text not null check (role in ('admin','support')), created_at timestamptz not null default now());
alter table public.admin_users enable row level security;
revoke all on public.admin_users from anon, authenticated; grant select on public.admin_users to authenticated;
create policy "own staff row" on public.admin_users for select using (user_id = auth.uid());

create function public.admin_role() returns text language sql stable security definer set search_path = public as $$
  select role from admin_users where user_id = auth.uid() $$;
grant execute on function public.admin_role() to authenticated;
-- Server-side authorization gate used by every staff function (not callable by clients).
create function public._need(roles text[]) returns uuid language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or coalesce(admin_role(), '') <> all(roles) then raise exception 'Not authorized'; end if;
  return auth.uid();
end $$;
revoke execute on function public._need(text[]) from public, anon, authenticated;

alter table public.transactions add column admin_id uuid, add column reason text;
create table public.audit_logs (id bigint generated always as identity primary key, admin_id uuid not null, action text not null,
  target_user uuid, details jsonb not null default '{}', created_at timestamptz not null default now());
alter table public.audit_logs enable row level security;
revoke all on public.audit_logs from anon, authenticated; grant select on public.audit_logs to authenticated;
create policy "staff read audit" on public.audit_logs for select using (admin_role() is not null);

-- Immutable records. (In dev, deleting a user with transactions needs: alter table transactions disable trigger tx_immutable.)
create function public._immutable() returns trigger language plpgsql as $$ begin raise exception 'Financial and audit records are immutable'; end $$;
create trigger tx_immutable before update or delete on public.transactions for each row execute function public._immutable();
create trigger audit_immutable before update or delete on public.audit_logs for each row execute function public._immutable();

-- Support tickets
create table public.support_tickets (ticket_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade, subject text not null, message text not null,
  status text not null default 'open' check (status in ('open','in_progress','resolved','closed')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.ticket_replies (id bigint generated always as identity primary key,
  ticket_id uuid not null references public.support_tickets on delete cascade, author_id uuid not null,
  is_staff boolean not null default false, message text not null, created_at timestamptz not null default now());
alter table public.support_tickets enable row level security; alter table public.ticket_replies enable row level security;
revoke all on public.support_tickets, public.ticket_replies from anon, authenticated;
grant select on public.support_tickets, public.ticket_replies to authenticated;
create policy "own or staff tickets" on public.support_tickets for select using (user_id = auth.uid() or admin_role() is not null);
create policy "own or staff replies" on public.ticket_replies for select using (exists (
  select 1 from public.support_tickets t where t.ticket_id = ticket_replies.ticket_id and (t.user_id = auth.uid() or admin_role() is not null)));

create function public.create_ticket(p_subject text, p_message text) returns uuid language plpgsql security definer set search_path = public as $$
declare id uuid;
begin
  if length(trim(coalesce(p_subject,''))) not between 3 and 120 then raise exception 'Subject must be 3 to 120 characters'; end if;
  if length(trim(coalesce(p_message,''))) not between 5 and 2000 then raise exception 'Message must be 5 to 2000 characters'; end if;
  if (select count(*) from support_tickets where user_id = auth.uid() and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'Ticket limit reached. Try again in an hour.'; end if;
  insert into support_tickets(user_id, subject, message) values (auth.uid(), trim(p_subject), trim(p_message)) returning ticket_id into id;
  return id;
end $$;
create function public.customer_reply(p_ticket uuid, p_message text) returns void language plpgsql security definer set search_path = public as $$
declare t support_tickets;
begin
  if length(trim(coalesce(p_message,''))) not between 1 and 2000 then raise exception 'Write a reply first (2000 characters max)'; end if;
  select * into t from support_tickets where ticket_id = p_ticket and user_id = auth.uid() for update;
  if not found then raise exception 'Ticket not found'; end if;
  if t.status = 'closed' then raise exception 'This ticket is closed. Open a new one.'; end if;
  insert into ticket_replies(ticket_id, author_id, message) values (p_ticket, auth.uid(), trim(p_message));
  update support_tickets set status = case when status = 'resolved' then 'open' else status end, updated_at = now() where ticket_id = p_ticket;
end $$;
create function public.admin_ticket_update(p_ticket uuid, p_status text, p_message text default null) returns void
language plpgsql security definer set search_path = public as $$
declare a uuid := _need(array['admin','support']); t support_tickets;
begin
  if p_status not in ('open','in_progress','resolved','closed') then raise exception 'Invalid status'; end if;
  select * into t from support_tickets where ticket_id = p_ticket for update;
  if not found then raise exception 'Ticket not found'; end if;
  if length(trim(coalesce(p_message,''))) > 2000 then raise exception 'Reply is too long'; end if;
  if length(trim(coalesce(p_message,''))) > 0 then
    insert into ticket_replies(ticket_id, author_id, is_staff, message) values (p_ticket, a, true, trim(p_message)); end if;
  update support_tickets set status = p_status, updated_at = now() where ticket_id = p_ticket;
  insert into audit_logs(admin_id, action, target_user, details) values (a, 'ticket_update', t.user_id,
    jsonb_build_object('ticket', p_ticket, 'from', t.status, 'to', p_status, 'replied', length(trim(coalesce(p_message,''))) > 0));
end $$;

-- Staff functions
create function public.admin_search(p_q text) returns table (user_id uuid, full_name text, email text, account_number text,
  checking_balance numeric, savings_balance numeric, account_status text) language plpgsql security definer set search_path = public as $$
begin
  perform _need(array['admin','support']);
  return query select p.user_id, p.full_name, p.email, p.account_number, p.checking_balance, p.savings_balance, p.account_status
    from profiles p where length(trim(p_q)) >= 3 and (p.account_number = trim(p_q) or p.user_id::text = trim(p_q) or p.email ilike '%' || trim(p_q) || '%')
    order by p.created_at desc limit 20;
end $$;
create function public.admin_user_transactions(p_user uuid) returns setof public.transactions language plpgsql security definer set search_path = public as $$
begin
  perform _need(array['admin','support']);
  return query select * from transactions where user_id = p_user order by created_at desc limit 100;
end $$;
create function public.admin_adjust_balance(p_user uuid, p_account text, p_type text, p_amount numeric, p_reason text, p_key uuid) returns text
language plpgsql security definer set search_path = public as $$
declare a uuid := _need(array['admin']); p profiles; credit boolean; ref text := 'AMB-' || replace(p_key::text,'-','');
begin
  if p_type not in ('admin_credit','admin_debit','manual_deposit') then raise exception 'Invalid operation'; end if;
  if p_account not in ('checking','savings') then raise exception 'Choose an account'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000 then raise exception 'Amount must be between $0.01 and $1,000,000'; end if;
  if length(trim(coalesce(p_reason,''))) < 5 then raise exception 'A reason of at least 5 characters is required'; end if;
  select * into p from profiles where user_id = p_user for update;
  if not found then raise exception 'Customer not found'; end if;
  credit := p_type <> 'admin_debit';
  if not credit and (case p_account when 'checking' then p.checking_balance else p.savings_balance end) < p_amount then
    raise exception 'Insufficient balance for this debit'; end if;
  update profiles set
    checking_balance = checking_balance + case when p_account = 'checking' then case when credit then p_amount else -p_amount end else 0 end,
    savings_balance  = savings_balance  + case when p_account = 'savings'  then case when credit then p_amount else -p_amount end else 0 end
  where user_id = p_user;
  insert into transactions(user_id, transaction_type, amount, description, reference_number, admin_id, reason)
  values (p_user, p_type, p_amount, case when credit then 'Credit to ' else 'Debit from ' end || p_account || ' by AmBank staff', ref, a, trim(p_reason));
  insert into audit_logs(admin_id, action, target_user, details)
  values (a, p_type, p_user, jsonb_build_object('account', p_account, 'amount', p_amount, 'reason', trim(p_reason), 'reference', ref));
  return ref;
end $$;
create function public.admin_set_status(p_user uuid, p_status text, p_reason text) returns void language plpgsql security definer set search_path = public as $$
declare a uuid := _need(array['admin']); old text;
begin
  if p_status not in ('active','frozen','suspended') then raise exception 'Invalid status'; end if;
  if length(trim(coalesce(p_reason,''))) < 5 then raise exception 'A reason of at least 5 characters is required'; end if;
  select account_status into old from profiles where user_id = p_user for update;
  if not found then raise exception 'Customer not found'; end if;
  update profiles set account_status = p_status where user_id = p_user;
  insert into audit_logs(admin_id, action, target_user, details) values (a, 'status_change', p_user,
    jsonb_build_object('from', old, 'to', p_status, 'reason', trim(p_reason)));
end $$;
-- Deleting the PIN record lets the customer create a new PIN themselves (set_pin only works when none exists).
create function public.admin_reset_pin(p_user uuid, p_reason text) returns void language plpgsql security definer set search_path = public as $$
declare a uuid := _need(array['admin']);
begin
  if length(trim(coalesce(p_reason,''))) < 5 then raise exception 'A reason of at least 5 characters is required'; end if;
  delete from transaction_security where user_id = p_user;
  insert into audit_logs(admin_id, action, target_user, details) values (a, 'pin_reset', p_user, jsonb_build_object('reason', trim(p_reason)));
end $$;

-- Rate-limit recipient lookups (closes the Phase 2 account-probing gap)
create table public.recipient_lookups (user_id uuid not null, at timestamptz not null default now());
create index on public.recipient_lookups (user_id, at);
alter table public.recipient_lookups enable row level security; revoke all on public.recipient_lookups from anon, authenticated;
create or replace function public.lookup_recipient(p_account text) returns text language plpgsql security definer set search_path = public as $$
declare n text;
begin
  delete from recipient_lookups where at < now() - interval '1 hour';
  if (select count(*) from recipient_lookups where user_id = auth.uid() and at > now() - interval '1 minute') >= 10 then
    raise exception 'Too many lookups. Wait a minute and try again.'; end if;
  insert into recipient_lookups(user_id) values (auth.uid());
  select regexp_replace(full_name, '^(\S+)\s+.*?(\S)\S*$', '\1 \2.') into n from profiles
   where account_number = p_account and user_id <> auth.uid() and account_status <> 'suspended';
  return n;
end $$;

grant execute on function public.create_ticket(text,text), public.customer_reply(uuid,text), public.admin_ticket_update(uuid,text,text),
  public.admin_search(text), public.admin_user_transactions(uuid), public.admin_adjust_balance(uuid,text,text,numeric,text,uuid),
  public.admin_set_status(uuid,text,text), public.admin_reset_pin(uuid,text), public.lookup_recipient(text) to authenticated;
-- Create your first admin AFTER registering that user normally:
-- insert into admin_users(user_id, role) select id, 'admin' from auth.users where email = 'you@example.com';

-- ==================== phase4.sql ====================
-- AmBank Phase 4. Run after phase3.sql.
-- Non-financial preferences are the one thing customers may write directly (still locked to their own row by RLS).
create table public.account_settings (user_id uuid primary key references public.profiles on delete cascade,
  hide_balances boolean not null default false, updated_at timestamptz not null default now());
alter table public.account_settings enable row level security;
revoke all on public.account_settings from anon, authenticated;
grant select, insert, update on public.account_settings to authenticated;
create policy "own settings read" on public.account_settings for select using (user_id = auth.uid());
create policy "own settings insert" on public.account_settings for insert with check (user_id = auth.uid());
create policy "own settings update" on public.account_settings for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ==================== phase5.sql ====================
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

-- ==================== phase6.sql ====================
-- AmBank Phase 6: in-app notifications and staff management. Run after phase5.sql.
create table public.notifications (id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles on delete cascade, title text not null, body text not null,
  read_at timestamptz, created_at timestamptz not null default now());
create index on public.notifications (user_id, created_at desc);
alter table public.notifications enable row level security;
revoke all on public.notifications from anon, authenticated; grant select on public.notifications to authenticated;
create policy "own notifications" on public.notifications for select using (user_id = auth.uid());
create function public.mark_notifications_read() returns void language sql security definer set search_path = public as $$
  update notifications set read_at = now() where user_id = auth.uid() and read_at is null $$;

-- Notifications are created by triggers, so no existing money function had to change.
create function public._notify_tx() returns trigger language plpgsql security definer set search_path = public as $$
declare amt text := '$' || to_char(new.amount, 'FM999,999,990.00');
begin
  if new.transaction_type = 'transfer_in' then
    insert into notifications(user_id, title, body) values (new.user_id, 'Money received', amt || ' arrived in your checking account. ' || coalesce(new.description, ''));
  elsif new.transaction_type in ('admin_credit', 'manual_deposit', 'admin_debit') then
    insert into notifications(user_id, title, body) values (new.user_id, 'Account adjustment',
      amt || case when new.transaction_type = 'admin_debit' then ' was debited from' else ' was credited to' end || ' your account by AmBank staff.');
  end if;
  return null;
end $$;
create trigger tx_notify after insert on public.transactions for each row execute function public._notify_tx();
create function public._notify_status() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.account_status <> old.account_status then
    insert into notifications(user_id, title, body) values (new.user_id, 'Account status changed',
      'Your account is now ' || new.account_status || '.' || case when new.account_status <> 'active' then ' Contact support for help.' else '' end);
  end if;
  return null;
end $$;
create trigger status_notify after update of account_status on public.profiles for each row execute function public._notify_status();
create function public._notify_reply() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.is_staff then
    insert into notifications(user_id, title, body) select user_id, 'Support replied', 'AmBank support replied to "' || left(subject, 60) || '".'
    from support_tickets where ticket_id = new.ticket_id;
  end if;
  return null;
end $$;
create trigger reply_notify after insert on public.ticket_replies for each row execute function public._notify_reply();
revoke execute on function public._notify_tx(), public._notify_status(), public._notify_reply() from public, anon, authenticated;

-- Staff management (admin role + two-step verification enforced by _need)
create function public.admin_list_staff() returns table (user_id uuid, email text, role text, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  perform _need(array['admin']);
  return query select s.user_id, u.email::text, s.role, s.created_at from admin_users s join auth.users u on u.id = s.user_id order by s.created_at;
end $$;
create function public.admin_set_staff(p_email text, p_role text) returns void language plpgsql security definer set search_path = public as $$
declare a uuid := _need(array['admin']); uid uuid;
begin
  if p_role not in ('admin', 'support', 'none') then raise exception 'Invalid role'; end if;
  select id into uid from auth.users where lower(email) = lower(trim(p_email));
  if uid is null then raise exception 'No registered user with that email. They must register first.'; end if;
  if uid = a then raise exception 'You cannot change your own role'; end if;
  if p_role = 'none' then delete from admin_users where user_id = uid;
  else insert into admin_users(user_id, role) values (uid, p_role) on conflict (user_id) do update set role = excluded.role; end if;
  insert into audit_logs(admin_id, action, target_user, details) values (a, 'staff_' || p_role, uid, jsonb_build_object('email', lower(trim(p_email))));
end $$;
grant execute on function public.mark_notifications_read(), public.admin_list_staff(), public.admin_set_staff(text, text) to authenticated;

-- ==================== phase7.sql ====================
-- AmBank Phase 7: live chat with support. Run after phase6.sql.
create table public.chat_conversations (id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade, customer_name text not null, account_number text not null,
  status text not null default 'waiting' check (status in ('waiting','active','closed')), staff_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), closed_at timestamptz);
create unique index one_open_chat_per_user on public.chat_conversations (user_id) where status <> 'closed';
create table public.chat_messages (id bigint generated always as identity primary key,
  conversation_id uuid not null references public.chat_conversations on delete cascade, sender_id uuid not null,
  is_staff boolean not null default false, body text not null check (char_length(body) between 1 and 1000), created_at timestamptz not null default now());
create index on public.chat_messages (conversation_id, id);
create table public.staff_presence (user_id uuid primary key references auth.users on delete cascade, last_seen timestamptz not null default now());

alter table public.chat_conversations enable row level security; alter table public.chat_messages enable row level security; alter table public.staff_presence enable row level security;
revoke all on public.chat_conversations, public.chat_messages, public.staff_presence from anon, authenticated;
grant select on public.chat_conversations, public.chat_messages to authenticated;
create policy "own or staff chats" on public.chat_conversations for select using (user_id = auth.uid() or staff_ok());
create policy "own or staff messages" on public.chat_messages for select using (exists (
  select 1 from public.chat_conversations c where c.id = chat_messages.conversation_id and (c.user_id = auth.uid() or staff_ok())));

-- Staff heartbeat drives the "team is online" check (online = seen in the last 90 seconds).
create function public.staff_heartbeat() returns void language plpgsql security definer set search_path = public as $$
begin
  perform _need(array['admin','support']);
  insert into staff_presence(user_id, last_seen) values (auth.uid(), now()) on conflict (user_id) do update set last_seen = now();
end $$;
create function public.chat_staff_online() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff_presence where last_seen > now() - interval '90 seconds') $$;

create function public.chat_start() returns uuid language plpgsql security definer set search_path = public as $$
declare p public.profiles; cid uuid;
begin
  select * into p from profiles where user_id = auth.uid();
  if not found then raise exception 'Not signed in'; end if;
  select c.id into cid from chat_conversations c where c.user_id = auth.uid() and c.status <> 'closed';
  if found then return cid; end if;
  if (select count(*) from chat_conversations where user_id = auth.uid() and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'Chat limit reached. Try again in an hour or open a support ticket.'; end if;
  if not chat_staff_online() then raise exception 'Our team is offline. Please open a support ticket instead.'; end if;
  insert into chat_conversations(user_id, customer_name, account_number) values (p.user_id, p.full_name, p.account_number) returning id into cid;
  return cid;
end $$;

create function public.chat_send(p_conv uuid, p_body text) returns void language plpgsql security definer set search_path = public as $$
declare c public.chat_conversations; staff boolean := false; b text := trim(coalesce(p_body, ''));
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if char_length(b) not between 1 and 1000 then raise exception 'Messages must be 1 to 1000 characters'; end if;
  if (select count(*) from chat_messages where sender_id = auth.uid() and created_at > now() - interval '1 minute') >= 20 then
    raise exception 'You are sending messages too fast. Wait a moment.'; end if;
  select * into c from chat_conversations where id = p_conv for update;
  if not found then raise exception 'Chat not found'; end if;
  if c.user_id <> auth.uid() then
    perform _need(array['admin','support']);
    if c.staff_id is distinct from auth.uid() then raise exception 'Claim this chat before replying'; end if;
    staff := true;
  end if;
  if c.status = 'closed' then raise exception 'This chat has ended'; end if;
  insert into chat_messages(conversation_id, sender_id, is_staff, body) values (p_conv, auth.uid(), staff, b);
  update chat_conversations set updated_at = now() where id = p_conv;
end $$;

create function public.chat_claim(p_conv uuid) returns void language plpgsql security definer set search_path = public as $$
declare a uuid := _need(array['admin','support']); c public.chat_conversations;
begin
  select * into c from chat_conversations where id = p_conv for update;
  if not found then raise exception 'Chat not found'; end if;
  if c.status = 'closed' then raise exception 'This chat has ended'; end if;
  if c.staff_id is not null and c.staff_id <> a then raise exception 'Another agent already has this chat'; end if;
  update chat_conversations set staff_id = a, status = 'active', updated_at = now() where id = p_conv;
  if c.staff_id is null then
    insert into chat_messages(conversation_id, sender_id, is_staff, body) values (p_conv, a, true, 'You are now chatting with AmBank support.');
    insert into audit_logs(admin_id, action, target_user, details) values (a, 'chat_claim', c.user_id, jsonb_build_object('chat', p_conv));
  end if;
end $$;

create function public.chat_close(p_conv uuid) returns void language plpgsql security definer set search_path = public as $$
declare c public.chat_conversations; a uuid;
begin
  select * into c from chat_conversations where id = p_conv for update;
  if not found then raise exception 'Chat not found'; end if;
  if c.status = 'closed' then return; end if;
  if c.user_id <> auth.uid() then
    a := _need(array['admin','support']);
    insert into audit_logs(admin_id, action, target_user, details) values (a, 'chat_close', c.user_id, jsonb_build_object('chat', p_conv));
  end if;
  update chat_conversations set status = 'closed', closed_at = now(), updated_at = now() where id = p_conv;
  insert into chat_messages(conversation_id, sender_id, is_staff, body) values (p_conv, auth.uid(), c.user_id <> auth.uid(), 'This chat has ended.');
end $$;

-- Turns an unresolved chat into a support ticket (transcript becomes the ticket message) and closes the chat.
create function public.chat_to_ticket(p_conv uuid) returns uuid language plpgsql security definer set search_path = public as $$
declare a uuid := _need(array['admin','support']); c public.chat_conversations; t text; tid uuid;
begin
  select * into c from chat_conversations where id = p_conv for update;
  if not found then raise exception 'Chat not found'; end if;
  if c.status = 'closed' then raise exception 'This chat has already ended'; end if;
  select string_agg(case when is_staff then 'Support: ' else 'Customer: ' end || body, E'\n' order by id) into t from chat_messages where conversation_id = p_conv;
  insert into support_tickets(user_id, subject, message) values (c.user_id, 'Live chat follow-up', left(coalesce(t, '(no messages)'), 2000)) returning ticket_id into tid;
  update chat_conversations set status = 'closed', closed_at = now(), updated_at = now() where id = p_conv;
  insert into chat_messages(conversation_id, sender_id, is_staff, body) values (p_conv, a, true, 'This chat was moved to a support ticket. Check the Support page for updates.');
  insert into audit_logs(admin_id, action, target_user, details) values (a, 'chat_to_ticket', c.user_id, jsonb_build_object('chat', p_conv, 'ticket', tid));
  return tid;
end $$;

grant execute on function public.staff_heartbeat(), public.chat_staff_online(), public.chat_start(), public.chat_send(uuid, text),
  public.chat_claim(uuid), public.chat_close(uuid), public.chat_to_ticket(uuid) to authenticated;

-- Realtime pushes new messages instantly (the app also polls every 4s as a fallback).
do $$ begin
  alter publication supabase_realtime add table public.chat_messages, public.chat_conversations;
exception when others then raise notice 'Enable Realtime for chat_messages and chat_conversations in the Supabase dashboard (%).', sqlerrm;
end $$;
