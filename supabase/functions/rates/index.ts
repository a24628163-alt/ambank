// Edge Function: proxies exchange rates from a public ECB-based provider. Deploy: supabase functions deploy rates
// Override the provider with: supabase secrets set RATES_API=https://...  (verify the default URL before launch)
const BASE = Deno.env.get('RATES_API') ?? 'https://api.frankfurter.dev/v1';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type' };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { from, to } = await req.json();
    if (![from, to].every((c) => /^[A-Z]{3}$/.test(c))) return reply({ error: 'Invalid currency' }, 400);
    const r = await fetch(`${BASE}/latest?base=${from}&symbols=${to}`);
    if (!r.ok) return reply({ error: 'Rate provider unavailable' }, 502);
    const d = await r.json();
    if (!d.rates?.[to]) return reply({ error: 'Rate not available' }, 404);
    return reply({ rate: d.rates[to], date: d.date, source: 'European Central Bank, via Frankfurter' });
  } catch { return reply({ error: 'Bad request' }, 400); }
});
