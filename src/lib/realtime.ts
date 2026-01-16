import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase environment variables for realtime')
}

export const supabaseRealtime = createClient(supabaseUrl, supabaseKey, {
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
  },
})

export interface GachaBroadcastPayload {
  type: 'gacha'
  card: {
    id: string
    name: string
    description: string | null
    image_url: string | null
    rarity: string
  }
  userTwitchUsername: string
}

export async function broadcastGachaResult(
  streamerId: string,
  payload: GachaBroadcastPayload
): Promise<void> {
  const channel = supabaseRealtime.channel(`gacha:${streamerId}`)
  
  await channel.send({
    type: 'broadcast',
    event: 'gacha_result',
    payload,
  })
}

export function subscribeToGachaResults(
  streamerId: string,
  callback: (payload: GachaBroadcastPayload) => void
): () => void {
  const channel = supabaseRealtime.channel(`gacha:${streamerId}`)
  
  channel
    .on('broadcast', { event: 'gacha_result' }, (payload) => {
      callback(payload.payload as GachaBroadcastPayload)
    })
    .subscribe()

  return () => {
    supabaseRealtime.removeChannel(channel)
  }
}
