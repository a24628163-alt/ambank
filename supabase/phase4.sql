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
