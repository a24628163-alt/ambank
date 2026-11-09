import { sb, money, setMsg, requireSession } from './app.js';
import { initBanking } from './transactions.js';
import { initNotifications } from './notifications.js';
import { initChat } from './chat.js';

const $ = id => document.getElementById(id);
await requireSession();

let profile, hidden = localStorage.getItem('ambank_hide') === '1';
const fmt = n => hidden ? '••••••••' : money(n);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// --- THEME TOGGLE LOGIC ---
const themeBtn = document.getElementById('themeToggle');
if (themeBtn) {
  const currentTheme = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', currentTheme);
  themeBtn.innerHTML = currentTheme === 'dark' ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';

  themeBtn.onclick = () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const newTheme = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    themeBtn.innerHTML = newTheme === 'dark' ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
  };
}
// --- END THEME TOGGLE ---

// --- LOAD FIAT WALLETS ---
async function loadFiatWallets() {
  const { data, error } = await sb.from('user_wallets').select('*').gt('balance', 0);
  const card = document.getElementById('fiatWalletCard');
  const list = document.getElementById('fiatWalletsList');
  
  if (error || !data || data.length === 0) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';
  list.innerHTML = data.map(w => `
    <div style="display:flex; justify-content:space-between;">
      <span>${w.currency}</span> 
      <span>${Number(w.balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
    </div>
  `).join('');
}

function render() {
  const p = profile, h = new Date().getHours();

  // --- PENDING APPROVAL GATE ---
  if (p.account_status === 'pending_approval') {
    document.body.innerHTML = `
      <div style="min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--bg); padding:1rem;">
        <div class="card" style="text-align:center; max-width:450px; padding:2.5rem;">
          <div style="font-size:3rem; color:var(--deep); margin-bottom:1rem;"><i class="fa-solid fa-shield-halved"></i></div>
          <h2 style="margin-top:0">Account Pending Review</h2>
          <p>Thank you for registering, <b>${esc(p.full_name)}</b>.</p>
          <p style="color:var(--muted); font-size:0.95rem;">Our compliance team is currently reviewing your KYC documents (ID and facial verification). This usually takes a few minutes.</p>
          <p style="color:var(--muted); font-size:0.95rem;">You will be able to access your dashboard and funds once approved.</p>
          <hr style="border:0; border-top:1px solid var(--border); margin:1.5rem 0;">
          <button class="btn ghost" id="logoutPending" style="width:100%">Sign Out</button>
        </div>
      </div>`;
    
    document.getElementById('logoutPending').onclick = async () => { 
      await sb.auth.signOut(); 
      location.replace('index.html'); 
    };
    return; // Stop rendering
  }
  // --- END PENDING GATE ---

  $('greeting').textContent = `${h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'}, ${p.full_name}`;
  $('date').textContent = new Date().toLocaleDateString(undefined, { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  $('total').textContent = fmt(Number(p.checking_balance) + Number(p.savings_balance));
  $('checkingBal').textContent = fmt(p.checking_balance);
  $('savingsBal').textContent = fmt(p.savings_balance);
  $('checkingNum').textContent = p.account_number + '-C';
  $('savingsNum').textContent = p.account_number + '-S';
  
  // Render Crypto Balances
  $('balBtc').textContent = Number(p.balance_btc || 0).toFixed(4);
  $('balEth').textContent = Number(p.balance_eth || 0).toFixed(4);
  $('balBnb').textContent = Number(p.balance_bnb || 0).toFixed(4);
  $('balSol').textContent = Number(p.balance_sol || 0).toFixed(4);
  
  // Tier & Status
  $('userTier').textContent = p.tier || 1;
  $('userStatus').textContent = p.account_status;
  $('userStatus').className = 'badge ' + p.account_status;

  $('statusBanner').hidden = p.account_status === 'active';
  $('bannerStatus').textContent = p.account_status;
  $('eye').innerHTML = `<i class="fa-solid fa-eye${hidden ? '-slash' : ''}"></i>`;
  $('eye').setAttribute('aria-label', hidden ? 'Show balances' : 'Hide balances');

  // Hide savings card if empty
  if (Number(p.savings_balance) === 0) {
      $('savingsCard').style.display = 'none';
  } else {
      $('savingsCard').style.display = 'block';
  }
}

async function load() {
  const { data, error } = await sb.from('profiles').select('*').single();
  if (error) { 
    $('total').textContent = 'Could not load your account. Refresh to try again.'; 
    return; 
  }
  profile = data;
  
  if (localStorage.getItem('ambank_hide') === null) { 
    const { data: s } = await sb.from('account_settings').select('hide_balances').maybeSingle(); 
    if (s) hidden = s.hide_balances; 
  }
  
  render();

  // If pending, stop here.
  if (profile.account_status === 'pending_approval') return;

  // Load transactions
  const { data: tx } = await sb.from('transactions').select('*').order('created_at', { ascending:false }).limit(20);
  $('txList').innerHTML = tx?.length
    ? tx.map(t => `<li><span>${esc(t.description)}<small>${esc(t.reference_number)} · ${new Date(t.created_at).toLocaleString()}</small></span><b>${money(t.amount)}</b></li>`).join('')
    : '<li>No transactions yet. Move funds to see activity here.</li>';

  // --- CALCULATE DAILY LIMIT ---
  const limit = profile.tier === 1 ? 5000 : profile.tier === 2 ? 50000 : 100000;
  
  const today = new Date().toISOString().split('T')[0];
  const { data: todayTx } = await sb.from('transactions')
      .select('amount')
      .eq('user_id', profile.user_id)
      .in('transaction_type', ['transfer_out', 'crypto_send'])
      .gte('created_at', today + 'T00:00:00Z');
      
  const sentToday = todayTx?.reduce((sum, t) => sum + Number(t.amount), 0) || 0;
  
  // Update progress bar
  const percentage = Math.min((sentToday / limit) * 100, 100);
  $('limitBar').style.width = percentage + '%';
  $('limitBar').style.background = percentage > 90 ? '#ff6b6b' : '#00CFC8';
  $('limitText').textContent = `$${sentToday.toLocaleString()} / $${limit.toLocaleString()}`;

  // Load Fiat Wallets
  await loadFiatWallets();
}

// 1. Load the profile data first
await load();

// 2. Initialize the UI only AFTER the profile is loaded and confirmed to be active
if (profile && profile.account_status !== 'pending_approval') {
  $('eye').onclick = () => { 
    hidden = !hidden; 
    localStorage.setItem('ambank_hide', hidden ? '1' : '0'); 
    sb.from('account_settings').upsert({ user_id: profile.user_id, hide_balances: hidden, updated_at: new Date().toISOString() }); 
    render(); 
  };

  $('logout').onclick = async () => { 
    await sb.auth.signOut(); 
    location.replace('index.html'); 
  };

  $('openMove').onclick = () => { 
    setMsg($('moveMsg'), ''); 
    $('moveModal').classList.add('open'); 
  };

  $('closeMove').onclick = () => $('moveModal').classList.remove('open');

  let key = crypto.randomUUID(); 

  $('moveForm').onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target)), btn = e.target.querySelector('.btn');
    btn.disabled = true; 
    setMsg($('moveMsg'), 'Moving funds…', 'ok');
    
    const { error } = await sb.rpc('move_funds', { p_from:f.from, p_to:f.to, p_amount:Number(f.amount), p_key:key });
    btn.disabled = false;
    
    if (error) return setMsg($('moveMsg'), error.message.includes('duplicate') ? 'This transfer was already processed.' : error.message);
    
    key = crypto.randomUUID(); 
    e.target.reset(); 
    $('moveModal').classList.remove('open'); 
    await load();
  };

  initBanking(load);
  initNotifications();
  initChat();
}