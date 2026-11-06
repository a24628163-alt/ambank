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
