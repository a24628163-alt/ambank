// Integration smoke test. Run ONLY against a DEV Supabase project (dev_mode = true, "Confirm email" off).
// Usage: cd tests && npm i && SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_KEY=... npm test
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
const { SUPABASE_URL: URL_, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_KEY: SVC } = process.env;
if (!URL_ || !ANON || !SVC) { console.error('Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_KEY (dev project only).'); process.exit(1); }
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); };
const svc = createClient(URL_, SVC);
async function user(tag) {
  const c = createClient(URL_, ANON), email = `ambank-test-${tag}-${randomUUID().slice(0, 8)}@example.com`;
  const { data, error } = await c.auth.signUp({ email, password: 'Test-' + randomUUID(), options: { data: { full_name: `Test ${tag}`, phone: '5550100' } } });
  if (error || !data.session) throw new Error('Sign-up failed, or email confirmation is on. ' + (error?.message ?? ''));
  return { c, id: data.user.id };
}
const a = await user('a'), b = await user('b');
const bal = async u => (await u.c.from('profiles').select('*').single()).data;
const pb = await bal(b);
check('customer sees only their own profile', (await a.c.from('profiles').select('*')).data?.length === 1);
check('direct balance update is rejected', !!(await a.c.from('profiles').update({ checking_balance: 999999 }).eq('user_id', a.id)).error);
const before = Number((await bal(a)).checking_balance);
let r = await a.c.rpc('deposit', { p_dest: 'checking', p_amount: 100, p_method: 'card', p_key: randomUUID() });
check('deposit succeeds', !r.error, r.error?.message);
check('deposit credits the balance', Number((await bal(a)).checking_balance) === before + 100);
check('PIN can be set', !(await a.c.rpc('set_pin', { p_pin: '1234' })).error);
const send = (pin, amt = 10, key = randomUUID()) => a.c.rpc('transfer_funds', { p_to: pb.account_number, p_amount: amt, p_desc: 'test', p_pin: pin, p_key: key });
r = await send('0000'); check('wrong PIN is refused', r.data?.ok === false, JSON.stringify(r));
const k = randomUUID(); r = await send('1234', 10, k); check('correct PIN transfer succeeds', r.data?.ok === true, JSON.stringify(r));
check('recipient is credited', Number((await bal(b)).checking_balance) === Number(pb.checking_balance) + 10);
r = await send('1234', 10, k); check('recipient gets a notification', (await b.c.from('notifications').select('*')).data?.some(n => n.title === 'Money received'));
check('replayed transfer key is rejected', !!r.error);
r = await send('1234', 1e7); check('overdraft is rejected', !!r.error);
for (let i = 0; i < 5; i++) await send('0000');
r = await send('1234'); check('5 wrong PINs lock transfers', r.data?.ok === false && /Too many/.test(r.data.error ?? ''), JSON.stringify(r));
await svc.from('profiles').update({ account_status: 'frozen' }).eq('user_id', a.id);
check('frozen account cannot send', !!(await send('1234')).error);
check('frozen account can still read history', !(await a.c.from('transactions').select('*')).error);
check('customer cannot call admin functions', !!(await a.c.rpc('admin_search', { p_q: 'example' })).error);
check('chat refuses when no staff are online', !!(await b.c.rpc('chat_start')).error);   // assumes no real staff online in dev
await svc.from('staff_presence').upsert({ user_id: a.id, last_seen: new Date().toISOString() });
const chat = await b.c.rpc('chat_start'); check('chat starts when staff are online', !chat.error, chat.error?.message);
check('customer can send a chat message', !(await b.c.rpc('chat_send', { p_conv: chat.data, p_body: 'hello' })).error);
check("other customers can't see the chat", (await a.c.from('chat_conversations').select('*')).data?.length === 0);
check("other customers can't send into it", !!(await a.c.rpc('chat_send', { p_conv: chat.data, p_body: 'hi' })).error);
check("customers can't claim chats", !!(await a.c.rpc('chat_claim', { p_conv: chat.data })).error);
await svc.from('staff_presence').delete().eq('user_id', a.id);
console.log(`\n${pass} passed, ${fail} failed. Test users (ambank-test-*) remain because transaction records are immutable.`);
process.exit(fail ? 1 : 0);
