// Shared: Supabase client + helpers. Keys come from js/config.js (the anon key is public by design; RLS protects data).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// "Remember me" off => session lives in sessionStorage and ends when the tab closes.
export const makeClient = remember => window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY,
  { auth: { storage: remember ? window.localStorage : window.sessionStorage } });

// Resolve the remember-me preference defensively:
//   1. sessionStorage wins (auth.js writes it on the current tab's last auth action).
//   2. Fall back to localStorage (survives tab close / new visit).
//   3. Default to "remember" when neither is set (fresh browser, or after logout cleared both).
// Wrapped in try/catch because storage can throw in Safari private mode / locked-down browsers.
function resolveRemember() {
  try {
    const s = sessionStorage.getItem('ambank_remember');
    if (s !== null) return s !== '0';
  } catch {}
  try {
    const l = localStorage.getItem('ambank_remember');
    if (l !== null) return l !== '0';
  } catch {}
  return true;
}

export const sb = makeClient(resolveRemember());

export const money = n => new Intl.NumberFormat('en-US', {style:'currency', currency:'USD'}).format(n);
export const setMsg = (el, text, kind='err') => { el.textContent = text; el.className = 'msg ' + kind; };
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export async function requireSession() {
  const { data:{ session } } = await sb.auth.getSession();
  if (!session) location.replace('login.html');
  return session;
}
