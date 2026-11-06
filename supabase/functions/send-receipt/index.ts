import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const body = await req.json()
    
    // The database webhook sends a payload with "record" (the new row)
    const record = body.record || body
    
    if (!record.user_id) {
      return new Response(JSON.stringify({ error: 'Missing user_id in payload' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      })
    }

    // Only send emails for successful transfers or deposits
    if (!['transfer_in', 'transfer_out', 'deposit'].includes(record.transaction_type)) {
      return new Response(JSON.stringify({ message: 'Ignored non-receipt transaction' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // Get the user's email and name
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('email, full_name')
      .eq('user_id', record.user_id)
      .single()

    if (profileError || !profile) {
      return new Response(JSON.stringify({ error: 'User not found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 404,
      })
    }

    const typeLabel =
      record.transaction_type === 'transfer_out' ? 'Transfer Sent' :
      record.transaction_type === 'transfer_in'  ? 'Transfer Received' :
      'Deposit'

    // Send via Resend
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'AmBank <onboarding@resend.dev>',
        // Hardcoded to your verified Resend email for testing
        to: ['a24628163@gmail.com'], 
        subject: `Receipt: ${typeLabel} of $${record.amount}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
            <h2 style="color: #008F95;">AmBank Receipt</h2>
            <p>Hello ${profile.full_name},</p>
            <p>${record.description || 'Your transaction was successful.'}</p>
            
            <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
              <tr style="border-bottom: 1px solid #eee;">
                <td style="padding: 10px 0; color: #666;">Type</td>
                <td style="padding: 10px 0; text-align: right; font-weight: bold;">${typeLabel}</td>
              </tr>
              <tr style="border-bottom: 1px solid #eee;">
                <td style="padding: 10px 0; color: #666;">Amount</td>
                <td style="padding: 10px 0; text-align: right; font-weight: bold; color: #008F95;">$${record.amount}</td>
              </tr>
              <tr style="border-bottom: 1px solid #eee;">
                <td style="padding: 10px 0; color: #666;">Date</td>
                <td style="padding: 10px 0; text-align: right;">${new Date(record.created_at || Date.now()).toLocaleString()}</td>
              </tr>
              <tr>
                <td style="padding: 10px 0; color: #666;">Reference</td>
                <td style="padding: 10px 0; text-align: right; font-family: monospace;">${record.reference_number}</td>
              </tr>
            </table>
            
            <p style="margin-top: 30px; font-size: 12px; color: #999; text-align: center;">
              Thank you for banking with AmBank.
            </p>
          </div>
        `,
      }),
    })

    const data = await res.json()
    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})