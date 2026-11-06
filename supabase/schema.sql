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
