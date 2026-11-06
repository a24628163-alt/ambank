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
