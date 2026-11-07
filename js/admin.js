import { sb, money, setMsg, esc } from './app.js';
import { openThread, LABEL } from './tickets.js';
import { mountChat } from './chatview.js';

const $ = id => document.getElementById(id);
let role = null, cur = null, found = [];

// Timers are cleared on logout so no RPC keeps firing after the session ends.
let chatsTimer = null, heartbeatTimer = null, notifTimer = null;

function stopTimers() {
  if (chatsTimer) { clearInterval(chatsTimer); chatsTimer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (notifTimer) { clearInterval(notifTimer); notifTimer = null; }
}

async function mfaGate() {
  const mfa = sb.auth.mfa, { data: aal } = await mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel === 'aal2') return true;
  const { data: f } = await mfa.listFactors(), box = $('mfa'), form = $('mfaForm'), msg = $('mfaMsg');
  for (const x of f?.all || []) if (x.status === 'unverified') await mfa.unenroll({ factorId: x.id });
  const factor = f?.totp?.[0]; let factorId;
  $('login').hidden = true; box.hidden = false;
  if (factor) { factorId = factor.id; $('mfaHelp').textContent = 'Enter the 6-digit code from your authenticator app.'; }
  else {
    const { data, error } = await mfa.enroll({ factorType: 'totp', friendlyName: 'AmBank staff ' + Date.now() });
    if (error) { setMsg(msg, error.message); return false; }
    factorId = data.id;
    $('mfaHelp').innerHTML = `Scan this QR code with an authenticator app, then enter the code.<br><img alt="QR code for authenticator app" src="${data.totp.qr_code}" width="180" height="180"><br><small class="sim">Or enter this key manually: ${esc(data.totp.secret)}</small>`;
  }
  return new Promise(res => { form.onsubmit = async e => {
    e.preventDefault();
    const { error } = await mfa.challengeAndVerify({ factorId, code: form.code.value.trim() });
    if (error) return setMsg(msg, error.message);
    box.hidden = true; res(true);
  }; });
}

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    const { data } = await sb.rpc('admin_role');
    if (data) {
      role = data;
      if (await mfaGate()) return show();
    }
    await sb.auth.signOut();
  }
  $('login').hidden = false; $('app').hidden = true;
}

function show() {
  stopTimers(); 
  $('login').hidden = true; $('app').hidden = false; $('role').textContent = role;
  document.querySelectorAll('.adminonly').forEach(e => e.hidden = role !== 'admin');
  
  // Load everything, including the new pending approvals list
  loadTickets(); loadAudit(); loadStaff(); loadChats(); loadDeposits();
  loadPendingApprovals(); // <-- NEW

  // Poll for new chats and deposits every 5s
  chatsTimer = setInterval(() => { loadChats(); loadDeposits(); loadPendingApprovals(); }, 5000); // Also poll pending users

  // Heartbeat
  const beat = () => sb.rpc('staff_heartbeat').then(({ error }) => { if (error) stopTimers(); });
  beat();
  heartbeatTimer = setInterval(beat, 30000);

  // Admin Notifications Poll
  loadAdminNotifications();
  notifTimer = setInterval(loadAdminNotifications, 30000);
}

$('loginForm').onsubmit = async e => {
  e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
  const { error } = await sb.auth.signInWithPassword({ email: f.email.trim(), password: f.password });
  if (error) return setMsg($('loginMsg'), error.message);
  const { data } = await sb.rpc('admin_role');
  if (!data) { await sb.auth.signOut(); return setMsg($('loginMsg'), 'This account does not have staff access.'); }
  role = data; if (await mfaGate()) show();
};

$('logout').onclick = async () => {
  stopTimers();
  await sb.auth.signOut();
  try { localStorage.removeItem('ambank_remember'); } catch {}
  try { sessionStorage.removeItem('ambank_remember'); } catch {}
  location.replace('/secret-admin-portal'); 
};

document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', x === b));
  document.querySelectorAll('.panel').forEach(p => p.hidden = p.id !== 'tab-' + b.dataset.tab);
});

// --- PENDING APPROVALS (NEW) ---
async function loadPendingApprovals() {
  const { data, error } = await sb.from('profiles')
    .select('*')
    .eq('account_status', 'pending_approval')
    .order('created_at', { ascending: false });

  if (error) return;

  const countBadge = $('pendingCount');
  if (data.length > 0) {
    countBadge.style.display = 'inline-block';
    countBadge.textContent = data.length;
  } else {
    countBadge.style.display = 'none';
  }

  $('pendingList').innerHTML = data.length ? data.map(c => `
    <li style="align-items: center; padding: 1rem 0;">
      <div>
        <b style="font-size: 1.05rem;">${esc(c.full_name)}</b><br>
        <small class="sim">${esc(c.email)} · NIN: ${esc(c.id_number || 'N/A')}</small>
      </div>
      <button class="btn ghost" style="padding: 0.4rem 0.8rem;" onclick="window.selectPending('${c.user_id}')">Review Details</button>
    </li>
  `).join('') : '<li>No pending approvals right now. 🎉</li>';
}

window.selectPending = (userId) => {
  // Instead of searching via ID, we do a fresh fetch to get full KYC data
  sb.from('profiles').select('*').eq('user_id', userId).single().then(({data}) => {
    if (data) select(data);
  });
};

// --- ADMIN NOTIFICATIONS ---
async function loadAdminNotifications() {
  const { count } = await sb.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
  const badge = $('adminBellCount');
  if (badge) {
    badge.hidden = !count;
    badge.textContent = count || '';
  }
}

$('adminBell').onclick = async () => {
  const { data, error } = await sb.from('notifications').select('*').order('created_at', { ascending: false }).limit(20);
  if (error) return alert('Could not load notifications.');
  
  const m = document.createElement('div');
  m.className = 'modal dyn open'; m.setAttribute('role', 'dialog');
  m.innerHTML = `<div class="card"><h3>Notifications</h3>
    <ul class="list" style="margin-bottom:1rem;">
      ${data.length ? data.map(n => `
        <li style="align-items:flex-start; ${n.read_at ? 'opacity:0.6;' : ''}">
          <span><b>${esc(n.title)}</b><br><small class="sim">${esc(n.body)}</small><br><small class="sim" style="font-size:0.7rem;">${new Date(n.created_at).toLocaleString()}</small></span>
        </li>
      `).join('') : '<li>No notifications.</li>'}
    </ul>
    <button class="btn" data-close>Close</button></div>`;
  m.onclick = e => { if (e.target === m || e.target.closest('[data-close]')) m.remove(); };
  document.body.append(m);

  if (data.some(n => !n.read_at)) { 
    await sb.rpc('mark_notifications_read'); 
    loadAdminNotifications(); 
  }
};

// --- CUSTOMERS & KYC ---
$('searchForm').onsubmit = async e => {
  e.preventDefault();
  const { data, error } = await sb.rpc('admin_search', { p_q: e.target.q.value.trim() });
  if (error) return $('results').innerHTML = `<li>${esc(error.message)}</li>`;
  found = data;
  $('results').innerHTML = data.length ? data.map(c => `<li><button class="link" data-u="${c.user_id}">${esc(c.full_name)}<small>${esc(c.email)} · ${esc(c.account_number)}</small></button></li>`).join('') : '<li>No matches.</li>';
};

$('results').onclick = e => { const b = e.target.closest('[data-u]'); if (b) select(found.find(c => c.user_id === b.dataset.u)); };

async function select(c) {
  cur = c; $('detail').hidden = false; $('dName').textContent = c.full_name;
  
  const { data: signedData } = await sb.storage.from('kyc-documents').createSignedUrl(`${c.user_id}/face.jpg`, 3600);

  const imgHtml = signedData?.signedUrl 
    ? `<img src="${signedData.signedUrl}" style="width:150px; height:150px; object-fit:cover; border-radius:10px; border: 1px solid var(--border); margin-top:10px;">` 
    : `<div style="width:150px; height:150px; background:var(--bg); display:flex; align-items:center; justify-content:center; border-radius:10px; font-size:12px; color:var(--muted); margin-top:10px;">No Photo</div>`;

  $('dInfo').innerHTML = `
    <div style="display:grid; grid-template-columns: 1fr 150px; gap: 1rem;">
      <div>
        ${esc(c.email)} · ${esc(c.account_number)}<br>
        <b>DOB:</b> ${esc(c.dob || 'N/A')} | <b>NIN:</b> ${esc(c.id_number || 'N/A')}<br>
        <b>Occupation:</b> ${esc(c.occupation || 'N/A')}<br>
        <b>Tier:</b> ${c.tier || 1} <br>
        Checking ${money(c.checking_balance)} · Savings ${money(c.savings_balance)}<br>
        <small>ID: ${esc(c.user_id)}</small>
      </div>
      <div>${imgHtml}</div>
    </div>
  `;
  
  $('dStatus').className = 'badge ' + c.account_status; 
  $('dStatus').textContent = c.account_status; 
  $('statusSel').value = (c.account_status === 'pending_approval' ? 'active' : c.account_status);

  const actionPanel = document.getElementById('kycActions');
  if (c.account_status === 'pending_approval') {
    actionPanel.hidden = false;
    document.getElementById('btnApprove').onclick = async () => {
      if(!confirm('Approve this customer and activate their account?')) return;
      const { error } = await sb.rpc('admin_approve_customer', { p_user: c.user_id });
      if (error) return alert(error.message);
      alert('Customer Approved!'); 
      loadPendingApprovals(); // Refresh the top list
      refresh();
    };
    document.getElementById('btnReject').onclick = async () => {
      if(!confirm('Reject this customer?')) return;
      const { error } = await sb.rpc('admin_reject_customer', { p_user: c.user_id });
      if (error) return alert(error.message);
      alert('Customer Rejected.'); 
      loadPendingApprovals();
      refresh();
    };
  } else {
    actionPanel.hidden = true;
  }

  const { data } = await sb.rpc('admin_user_transactions', { p_user: c.user_id });
  $('dTx').innerHTML = data?.length ? data.map(t => `<li><span>${esc(t.description)}<small>${esc(t.reference_number)} · ${new Date(t.created_at).toLocaleString()}${t.reason ? ' · ' + esc(t.reason) : ''}</small></span><b>${money(t.amount)}</b></li>`).join('') : '<li>No transactions.</li>';
}

async function refresh() {
  const { data } = await sb.rpc('admin_search', { p_q: cur.user_id });
  if (data?.[0]) { found = found.map(x => x.user_id === cur.user_id ? data[0] : x); select(data[0]); }
  loadAudit();
}

function act(id, fn, args, ask) {
  $(id).onsubmit = async e => {
    e.preventDefault(); if (!cur && id !== 'staffForm') return;
    const f = Object.fromEntries(new FormData(e.target)), msg = e.target.querySelector('.msg');
    if (!confirm(ask(f))) return;
    setMsg(msg, 'Working…', 'ok');
    const { error } = await sb.rpc(fn, args(f));
    if (error) return setMsg(msg, error.message);
    e.target.reset(); setMsg(msg, 'Done. Recorded in the audit log.', 'ok');
    id === 'staffForm' ? (loadStaff(), loadAudit()) : refresh();
  };
}
act('statusForm', 'admin_set_status', f => ({ p_user: cur.user_id, p_status: f.status, p_reason: f.reason }), f => `Set ${cur.full_name}'s account to ${f.status}?`);
act('adjustForm', 'admin_adjust_balance', f => ({ p_user: cur.user_id, p_account: f.account, p_type: f.type, p_amount: Number(f.amount), p_reason: f.reason, p_key: crypto.randomUUID() }),
  f => `${f.type.replace('_', ' ')} of ${money(f.amount)} on ${f.account} for ${cur.full_name}? This cannot be undone.`);
act('pinForm', 'admin_reset_pin', f => ({ p_user: cur.user_id, p_reason: f.reason }), () => `Reset the transaction PIN for ${cur.full_name}?`);

// --- PENDING DEPOSITS & TRANSFER FEES ---
async function loadDeposits() {
  const { data, error } = await sb.from('pending_deposits').select('*, profiles(full_name, email)').eq('status', 'pending').order('created_at');
  if(error) return;
  
  $('depositList').innerHTML = data.length ? data.map(d => {
    const isTransferFee = d.details && d.details.generated_code;
    const codeDisplay = isTransferFee ? `<br><b>Code to release:</b> <span style="font-size:1.2rem; color:var(--deep); letter-spacing:2px;">${d.details.generated_code}</span>` : '';
    const title = isTransferFee ? 'Transfer Fee Payment' : 'Account Deposit';

    return `
    <li style="align-items: flex-start; padding: 1rem 0;">
      <div>
        <b>${title}</b><br>
        <b>${esc(d.profiles.full_name)}</b> (${esc(d.profiles.email)})<br>
        <span style="color: var(--deep); font-weight:bold; font-size:1.1rem;">${d.currency} ${d.amount}</span><br>
        <small class="sim">via ${d.method.replace('_', ' ')} · ${new Date(d.created_at).toLocaleString()}</small>
        ${codeDisplay}
      </div>
      <button class="btn" style="background:#237A3B; font-size:0.8rem; padding:0.5rem 1rem;" onclick="window.approveDep('${d.id}')">Approve</button>
    </li>
  `}).join('') : '<li>No pending deposits or fees.</li>';
}

window.approveDep = async (id) => {
  if(!confirm('Have you verified that the funds were received? If this is a Transfer Fee, please give the code to the customer.')) return;
  const { error } = await sb.rpc('admin_approve_deposit', { p_id: id });
  if (error) return alert(error.message);
  alert('Approved successfully!');
  loadDeposits();
};

// --- LIVE CHATS ---
let chats = [], chatView = null;

async function loadChats() {
  const { data, error } = await sb.from('chat_conversations').select('*').neq('status', 'closed').order('created_at');
  if (error) {
    if (/JWT|auth|Not authorized|permission/i.test(error.message)) stopTimers();
    return;
  }
  chats = data; const waiting = data.filter(c => c.status === 'waiting').length;
  $('chatTab').textContent = waiting ? `Live chats (${waiting})` : 'Live chats';
  $('cList').innerHTML = data.length ? data.map(c => `<li><button class="link" data-c="${c.id}"><b>${esc(c.customer_name)}</b><small>${esc(c.account_number)} · ${new Date(c.created_at).toLocaleTimeString()}</small></button><span class="badge ${c.status === 'waiting' ? 'open' : 'in_progress'}">${c.status}</span></li>`).join('') : '<li>No open chats.</li>';
}
$('cList').onclick = e => { const b = e.target.closest('[data-c]'); if (b) openChat(chats.find(c => c.id === b.dataset.c)); };

async function openChat(c) {
  chatView?.destroy();
  $('cPane').innerHTML = `<h3 style="margin-top:0">${esc(c.customer_name)} <small class="sim">${esc(c.account_number)}</small></h3><div class="actions" style="margin-bottom:.8rem"><button class="btn" id="cClaim">Claim chat</button><button class="btn ghost" id="cTicket">Convert to ticket</button><button class="btn ghost" id="cClose">Close chat</button></div><p class="msg" id="cMsg" role="alert"></p><div id="cBody"></div>`;
  chatView = await mountChat($('cBody'), c.id, true, loadChats);
  const run = (id, fn, ok) => $(id).onclick = async () => {
    const { error } = await sb.rpc(fn, { p_conv: c.id });
    if (error) return setMsg($('cMsg'), error.message);
    setMsg($('cMsg'), ok, 'ok'); chatView.refresh(); loadChats();
  };
  run('cClaim', 'chat_claim', 'You claimed this chat.'); run('cTicket', 'chat_to_ticket', 'Converted to a ticket and closed.'); run('cClose', 'chat_close', 'Chat closed.');
}

// --- STAFF ---
async function loadStaff() {
  if (role !== 'admin') return;
  const { data, error } = await sb.rpc('admin_list_staff');
  $('staffList').innerHTML = error ? `<li>${esc(error.message)}</li>` : data.map(s => `<li><span>${esc(s.email)}<small class="sim"> since ${new Date(s.created_at).toLocaleDateString()}</small></span><span class="badge active">${esc(s.role)}</span></li>`).join('');
}
act('staffForm', 'admin_set_staff', f => ({ p_email: f.email, p_role: f.role }), f => `Set ${f.email} to "${f.role}"?`);

// --- TICKETS ---
async function loadTickets() {
  let q = sb.from('support_tickets').select('*').order('updated_at', { ascending: false }).limit(100);
  if ($('tFilter').value) q = q.eq('status', $('tFilter').value);
  const { data, error } = await q;
  $('tList').innerHTML = error ? '<li>Could not load tickets.</li>' : data.length ? data.map(t => `<li><button class="link" data-t="${t.ticket_id}"><b>${esc(t.subject)}</b><small>${new Date(t.updated_at).toLocaleString()}</small></button><span class="badge ${t.status}">${LABEL[t.status]}</span></li>`).join('') : '<li>No tickets in this view.</li>';
}
$('tFilter').onchange = loadTickets;
$('tList').onclick = e => { const b = e.target.closest('[data-t]'); if (b) openThread($('tThread'), b.dataset.t, true, loadTickets); };

// --- AUDIT LOG ---
async function loadAudit() {
  const { data } = await sb.from('audit_logs').select('*').order('id', { ascending: false }).limit(100);
  $('aBody').innerHTML = (data || []).map(a => `<tr><td>${new Date(a.created_at).toLocaleString()}</td><td>${esc(a.admin_id.slice(0, 8))}</td><td>${esc(a.action)}</td><td>${esc((a.target_user || '').slice(0, 8))}</td><td>${esc(JSON.stringify(a.details))}</td></tr>`).join('') || '<tr><td colspan="5">No activity yet.</td></tr>';
}

// --- FIRST TIME SETUP ---
async function checkAdminExists() {
  const { count } = await sb.from('admin_users').select('id', { count: 'exact', head: true });
  return count && count > 0;
}

async function setupFirstAdminButton() {
  const hasAdmin = await checkAdminExists();
  
  if (!hasAdmin) {
    const loginForm = $('loginForm');
    const setupBtn = document.createElement('button');
    setupBtn.type = 'button';
    setupBtn.className = 'btn ghost';
    setupBtn.style.cssText = 'width:100%; margin-top:0.5rem; color: var(--deep);';
    setupBtn.textContent = 'First Time Setup: Make Me Admin';
    loginForm.appendChild(setupBtn);
    
    setupBtn.onclick = async () => {
      const email = prompt('Enter your email (must be registered as a user first):');
      if (!email) return;
      const password = prompt('Enter your password:');
      if (!password) return;
      
      const { error: loginErr } = await sb.auth.signInWithPassword({ email: email.trim(), password });
      if (loginErr) return alert('Login failed: ' + loginErr.message);
      
      const { data, error } = await sb.rpc('become_first_admin');
      if (error) return alert('Error: ' + error.message);
      
      if (data.ok) {
        alert('You are now the Admin! Reloading to set up two-step verification...');
        location.reload();
      } else {
        alert(data.error);
      }
    };
  }
}

// Run startup
boot();
setupFirstAdminButton();