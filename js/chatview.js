// Shared chat window for customers (chat.js) and staff (admin.js). Realtime for speed, 4s polling as a safety net.
import { sb, esc, setMsg } from './app.js';
export async function mountChat(el, id, staff, onClosed) {
  el.innerHTML = `<ul class="chatlog" aria-live="polite"></ul><form class="chatform"><input name="m" maxlength="1000" autocomplete="off" placeholder="Type a message" aria-label="Message" required><button class="btn">Send</button></form><p class="msg" role="alert"></p>`;
  const log = el.querySelector('.chatlog'), form = el.querySelector('form'), msg = el.querySelector('.msg'), seen = new Set();
  let last = 0, closed = false, ch, timer;
  const add = m => {
    if (seen.has(m.id)) return; seen.add(m.id); last = Math.max(last, m.id);
    const li = document.createElement('li'); li.className = m.is_staff === staff ? 'me' : 'them';
    li.innerHTML = `<small>${m.is_staff ? 'AmBank support' : 'Customer'} · ${new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small><p>${esc(m.body)}</p>`;
    log.append(li); log.scrollTop = log.scrollHeight;
  };
  const stop = () => { clearInterval(timer); if (ch) sb.removeChannel(ch); };
  const sync = async () => {
    const { data } = await sb.from('chat_messages').select('*').eq('conversation_id', id).gt('id', last).order('id');
    data?.forEach(add);
    const { data: c } = await sb.from('chat_conversations').select('status').eq('id', id).single();
    if (c?.status === 'closed' && !closed) { closed = true; stop(); form.hidden = true; setMsg(msg, 'This chat has ended.', 'ok'); onClosed?.(); }
  };
  await sync();
  if (!closed) {
    ch = sb.channel('chat-' + id).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `conversation_id=eq.${id}` }, p => add(p.new)).subscribe();
    timer = setInterval(sync, 4000);
  }
  form.onsubmit = async e => {
    e.preventDefault(); const body = form.m.value.trim(); if (!body) return;
    form.m.value = '';
    const { error } = await sb.rpc('chat_send', { p_conv: id, p_body: body });
    if (error) { form.m.value = body; return setMsg(msg, error.message); }
    setMsg(msg, ''); sync();
  };
  return { destroy: stop, refresh: sync };
}
