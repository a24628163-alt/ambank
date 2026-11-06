import { sb, setMsg } from './app.js';
const form = document.getElementById('resetForm'), msg = document.getElementById('msg'), fmsg = document.getElementById('formMsg');
// The emailed link signs the user into a short-lived recovery session; Supabase then fires PASSWORD_RECOVERY.
sb.auth.onAuthStateChange(ev => { if (ev === 'PASSWORD_RECOVERY') { form.hidden = false; msg.textContent = ''; } });
setTimeout(() => { if (form.hidden) setMsg(msg, 'This reset link is invalid or has expired. Request a new one from the sign-in page.'); }, 4000);
form.onsubmit = async e => {
  e.preventDefault(); const f = Object.fromEntries(new FormData(form));
  if (f.password.length < 8) return setMsg(fmsg, 'Password must be at least 8 characters');
  if (f.password !== f.confirm) return setMsg(fmsg, 'Passwords do not match');
  const { error } = await sb.auth.updateUser({ password: f.password });
  if (error) return setMsg(fmsg, error.message);
  await sb.auth.signOut(); setMsg(fmsg, 'Password updated. Taking you to sign in…', 'ok'); setTimeout(() => location.href = 'login.html', 1500);
};
