// Sign in with a 10-digit account number. The email is looked up server-side and never sent to the browser.
// Deploy: supabase functions deploy login   (SUPABASE_URL / ANON / SERVICE_ROLE keys are provided automatically)
import { createClient } from 'npm:@supabase/supabase-js@2';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type' };
const reply = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { identifier, password } = await req.json();
    if (!/^\d{10}$/.test(identifier ?? '') || typeof password !== 'string' || !password) return reply({ error: 'Invalid login credentials' }, 400);
    const url = Deno.env.get('SUPABASE_URL')!;
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: p } = await admin.from('profiles').select('email').eq('account_number', identifier).maybeSingle();
    // Identical response for unknown account and wrong password, so account numbers can't be probed.
    if (!p) return reply({ error: 'Invalid login credentials' }, 401);
    const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!);
    const { data, error } = await anon.auth.signInWithPassword({ email: p.email, password });
    if (error || !data.session) return reply({ error: 'Invalid login credentials' }, 401);
    return reply({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
  } catch { return reply({ error: 'Bad request' }, 400); }
});
