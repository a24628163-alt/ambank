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
