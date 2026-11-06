import { sb, money, esc, requireSession } from './app.js';
await requireSession();
const LBL = { deposit: 'Deposit', transfer_in: 'Transfer in', transfer_out: 'Transfer out', move_funds: 'Move funds', admin_credit: 'Credit', admin_debit: 'Debit', manual_deposit: 'Manual deposit' };
const IN = ['deposit', 'transfer_in', 'admin_credit', 'manual_deposit'], OUT = ['transfer_out', 'admin_debit'];
const { data, error } = await sb.from('transactions').select('*').order('created_at', { ascending: false }).limit(200);
const sel = document.getElementById('type'), body = document.getElementById('rows');
sel.innerHTML = '<option value="">All types</option>' + Object.entries(LBL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
function draw() {
  const rows = (data || []).filter(t => !sel.value || t.transaction_type === sel.value);
  body.innerHTML = error ? '<tr><td colspan="4">Could not load transactions. Refresh to try again.</td></tr>' : rows.length
    ? rows.map(t => `<tr><td>${new Date(t.created_at).toLocaleString()}</td><td>${esc(t.description)}<br><small class="sim">${esc(t.reference_number)} · ${esc(LBL[t.transaction_type] || t.transaction_type)}</small></td><td>${esc(t.status)}</td><td style="text-align:right"><b>${IN.includes(t.transaction_type) ? '+' : OUT.includes(t.transaction_type) ? '−' : ''}${money(t.amount)}</b></td></tr>`).join('')
    : '<tr><td colspan="4">No transactions match this filter.</td></tr>';
}
sel.onchange = draw; draw();

// CSV export: cells starting with = + - @ are prefixed so spreadsheet apps can't run them as formulas.
const cell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
document.getElementById('csv').onclick = () => {
  const rows = (data || []).filter(t => !sel.value || t.transaction_type === sel.value);
  const lines = [['Date', 'Reference', 'Type', 'Description', 'Status', 'Amount (USD)', 'Direction'],
    ...rows.map(t => [new Date(t.created_at).toISOString(), t.reference_number, t.transaction_type, t.description, t.status, t.amount, IN.includes(t.transaction_type) ? 'in' : OUT.includes(t.transaction_type) ? 'out' : 'internal'])].map(r => r.map(cell).join(','));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv' }));
  a.download = `ambank-transactions-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(a.href);
};
document.getElementById('print').onclick = () => window.print();
const { data: me } = await sb.from('profiles').select('full_name,account_number').single();
if (me) document.getElementById('stmtHead').textContent = `AmBank statement for ${me.full_name}, account ${me.account_number}. Generated ${new Date().toLocaleString()}. Simulated funds.`;
