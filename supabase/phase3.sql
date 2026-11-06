-- AmBank Phase 3. Run after phase2.sql. SIMULATED FUNDS ONLY.
-- Support role can view customers, tickets, chats, and balances — but cannot change money, status, PINs, or staff.
-- Only `admin` role + aal2 (after phase5.sql) can mutate financial or account state.
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
-- phase5.sql replaces this function to additionally require aal2 (two-step verification).
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
-- phase5.sql replaces this policy so only staff with aal2 can read the audit log.
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
-- phase5.sql replaces both policies so staff reads also require aal2.
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

-- Staff ticket updates require admin OR support (but phase5.sql adds the aal2 gate on top).
-- Validation happens AFTER authz so an unauthenticated caller can't probe valid statuses.
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
-- Support + admin can search customers (including balances) for ticket triage. Write access below is admin-only.
create function public.admin_search(p_q text) returns table (user_id uuid, full_name text, email text, account_number text,
  checking_balance numeric, savings_balance numeric, account_status text) language plpgsql security definer set search_path = public as $$
begin
  perform _need(array['admin','support']);
  return query select p.user_id, p.full_name, p.email, p.account_number, p.checking_balance, p.savings_balance, p.account_status
    from profiles p where length(trim(p_q)) >= 3 and (p.account_number = trim(p_q) or p.user_id::text = trim(p_q) or p.email ilike '%' || trim(p_q) || '%')
    order by p.created_at desc limit 20;
end $$;

-- Support + admin can read the transaction history (with amounts) for a specific customer. Admin-only mutations elsewhere.
create function public.admin_user_transactions(p_user uuid) returns setof public.transactions language plpgsql security definer set search_path = public as $$
begin
  perform _need(array['admin','support']);
  return query select * from transactions where user_id = p_user order by created_at desc limit 100;
end $$;

-- Admin-only: adjust balances. Requires aal2 after phase5.sql.
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

-- Admin-only: change account status. Requires aal2 after phase5.sql.
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

-- Admin-only: reset transaction PIN. Requires aal2 after phase5.sql.
-- Deleting the PIN record lets the customer create a new PIN themselves (set_pin only works when none exists).
create function public.admin_reset_pin(p_user uuid, p_reason text) returns void language plpgsql security definer set search_path = public as $$
declare a uuid := _need(array['admin']);
begin
  if length(trim(coalesce(p_reason,''))) < 5 then raise exception 'A reason of at least 5 characters is required'; end if;
  delete from transaction_security where user_id = p_user;
  insert into audit_logs(admin_id, action, target_user, details) values (a, 'pin_reset', p_user, jsonb_build_object('reason', trim(p_reason)));
end $$;

-- Rate-limit recipient lookups (closes the Phase 2 account-probing gap).
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