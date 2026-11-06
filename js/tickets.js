// Shared ticket thread view for customers (support.html) and staff (admin.html). Authorization is enforced by RLS + RPCs.
import { sb, setMsg, esc } from './app.js';
export const LABEL = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed' };
export async function openThread(el, id, staff, onChange) {
  const [{ data: t }, { data: r }] = await Promise.all([
    sb.from('support_tickets').select('*').eq('ticket_id', id).single(),
    sb.from('ticket_replies').select('*').eq('ticket_id', id).order('created_at')]);
  if (!t) { el.textContent = 'Ticket not found.'; return; }
  const msgs = [{ staff: false, message: t.message, at: t.created_at }, ...(r || []).map(x => ({ staff: x.is_staff, message: x.message, at: x.created_at }))];
  const next = t.status === 'open' ? 'in_progress' : t.status;
  el.innerHTML = `<h3>${esc(t.subject)} <span class="badge ${t.status}">${LABEL[t.status]}</span></h3><small class="sim">Ticket ${esc(t.ticket_id)}</small>
    <ul class="thread">${msgs.map(m => `<li class="${m.staff ? 'staff' : ''}"><small>${m.staff ? 'AmBank support' : 'Customer'} · ${new Date(m.at).toLocaleString()}</small><p>${esc(m.message)}</p></li>`).join('')}</ul>
    ${t.status === 'closed' && !staff ? '<p class="sim">This ticket is closed. Open a new one if you still need help.</p>' : `<form><label class="field">Reply<textarea name="m" rows="3" maxlength="2000" ${staff ? '' : 'required'}></textarea></label>
    ${staff ? `<label class="field">Status<select name="s">${Object.entries(LABEL).map(([k, v]) => `<option value="${k}" ${k === next ? 'selected' : ''}>${v}</option>`).join('')}</select></label>` : ''}
    <p class="msg" role="alert"></p><button class="btn">${staff ? 'Update ticket' : 'Send reply'}</button></form>`}`;
  const f = el.querySelector('form');
  if (f) f.onsubmit = async e => {
    e.preventDefault(); const m = f.m.value.trim(), msg = f.querySelector('.msg');
    const { error } = staff ? await sb.rpc('admin_ticket_update', { p_ticket: id, p_status: f.s.value, p_message: m || null })
                            : await sb.rpc('customer_reply', { p_ticket: id, p_message: m });
    if (error) return setMsg(msg, error.message);
    await openThread(el, id, staff, onChange); onChange?.();
  };
}
