import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { from, to } = await req.json()
    
    if (!from || !to) throw new Error('Missing currencies')
    
    const fromUpper = from.toUpperCase()
    const toUpper = to.toUpperCase()

    // 1. Try Frankfurter API (ECB Data)
    try {
      const res = await fetch(`https://api.frankfurter.app/latest?from=${fromUpper}&to=${toUpper}`)
      if (res.ok) {
        const data = await res.json()
        if (data.rates && data.rates[toUpper]) {
          return new Response(JSON.stringify({ 
            rate: data.rates[toUpper], 
            source: 'European Central Bank', 
            date: data.date 
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
        }
      }
    } catch (e) {
      console.log('Frankfurter failed, trying fallback...')
    }

    // 2. Fallback: ExchangeRate-API (Free Open Access)
    const fallbackRes = await fetch(`https://open.er-api.com/v6/latest/${fromUpper}`)
    if (!fallbackRes.ok) throw new Error('Rate provider unavailable')
    
    const fallbackData = await fallbackRes.json()
    if (fallbackData.result === 'success' && fallbackData.rates[toUpper]) {
      return new Response(JSON.stringify({ 
        rate: fallbackData.rates[toUpper], 
        source: 'Open Exchange Rates', 
        date: new Date(fallbackData.time_last_update_unix * 1000).toISOString().split('T')[0]
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    throw new Error('Rate not available for this pair')

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 
    })
  }
})