import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Map symbols to CoinGecko IDs
const COIN_IDS: Record<string, string> = {
  'BTC': 'bitcoin',
  'ETH': 'ethereum',
  'BNB': 'binancecoin',
  'SOL': 'solana',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { from, to } = await req.json()
    
    const fromUpper = from.toUpperCase()
    const toUpper = to.toUpperCase()

    const isFromCrypto = !!COIN_IDS[fromUpper]
    const isToCrypto = !!COIN_IDS[toUpper]

    // --- CASE 1 & 2: One side is Crypto, the other is Fiat ---
    // Example: BTC -> USD  OR  USD -> BTC
    if (isFromCrypto || isToCrypto) {
      const coinId = isFromCrypto ? COIN_IDS[fromUpper] : COIN_IDS[toUpper]
      const vsCurrency = isFromCrypto ? toUpper.toLowerCase() : fromUpper.toLowerCase()
      
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=${vsCurrency}`
      const res = await fetch(url)
      
      if (!res.ok) throw new Error('Failed to fetch from CoinGecko')
      
      const data = await res.json()
      if (!data[coinId] || !data[coinId][vsCurrency]) {
        throw new Error(`Price for ${coinId} in ${vsCurrency} not available`)
      }

      const price = data[coinId][vsCurrency]
      
      // If From is Crypto (BTC -> USD), rate is 1 BTC = X USD.
      // If To is Crypto (USD -> BTC), rate is 1 USD = Y BTC, so we invert the price.
      const rate = isFromCrypto ? price : 1 / price

      return new Response(JSON.stringify({ rate }), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      })
    }

    // --- CASE 3: Crypto -> Crypto ---
    // Example: BTC -> ETH. We must bridge via USD.
    if (isFromCrypto && isToCrypto) {
      const fromId = COIN_IDS[fromUpper]
      const toId = COIN_IDS[toUpper]

      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${fromId},${toId}&vs_currencies=usd`
      const res = await fetch(url)
      
      if (!res.ok) throw new Error('Failed to fetch from CoinGecko')
      
      const data = await res.json()
      const fromPrice = data[fromId].usd
      const toPrice = data[toId].usd

      const rate = fromPrice / toPrice

      return new Response(JSON.stringify({ rate }), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      })
    }

    throw new Error('Invalid conversion pair')

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 
    })
  }
})
