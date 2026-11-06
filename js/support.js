import { sb, setMsg, esc, requireSession } from './app.js';
import { openThread, LABEL } from './tickets.js';
import { initChat } from './chat.js';
const $ = id => document.getElementById(id);
await requireSession();
async function list() {
  const { data, error } = await sb.from('support_tickets').select('*').order('created_at', { ascending: false });
  $('tickets').innerHTML = error ? '<li>Could not load your tickets. Refresh to try again.</li>' : data.length
    ? data.map(t => `<li><button class="link" data-id="${t.ticket_id}"><b>${esc(t.subject)}</b><small>${new Date(t.created_at).toLocaleString()}</small></button><span class="badge ${t.status}">${LABEL[t.status]}</span></li>`).join('')
    : '<li>No tickets yet. Describe an issue above and we will reply here.</li>';
}
$('tickets').onclick = e => { const b = e.target.closest('[data-id]'); if (b) openThread($('thread'), b.dataset.id, false, list); };
$('ticketForm').onsubmit = async e => {
  e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)), msg = $('ticketMsg'), btn = e.target.querySelector('.btn');
  btn.disabled = true; setMsg(msg, 'Sending…', 'ok');
  const { data, error } = await sb.rpc('create_ticket', { p_subject: f.subject, p_message: f.message });
  btn.disabled = false;
  if (error) return setMsg(msg, error.message);
  setMsg(msg, 'Ticket submitted. We will reply here.', 'ok'); e.target.reset(); await list(); openThread($('thread'), data, false, list);
};
list();
initChat();
