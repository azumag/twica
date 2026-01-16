import { createClient, SupabaseClient } from '@supabase/supabase-js'

let supabaseRealtime: SupabaseClient | null = null

function getSupabaseRealtimeClient(): SupabaseClient {
  if (supabaseRealtime) {
    return supabaseRealtime
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseKey) {
    if (process.env.CI || process.env.NODE_ENV === 'test') {
      throw new Error('Realtime not available in CI/test environment')
    } else {
      throw new Error('Missing Supabase environment variables for realtime')
    }
  }

  supabaseRealtime = createClient(supabaseUrl, supabaseKey, {
    realtime: {
      params: {
        eventsPerSecond: 10,
      },
    },
  })

  return supabaseRealtime
}

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
  const client = getSupabaseRealtimeClient()
  const channel = client.channel(`gacha:${streamerId}`)

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
  const client = getSupabaseRealtimeClient()
  const channel = client.channel(`gacha:${streamerId}`)

  channel
    .on('broadcast', { event: 'gacha_result' }, (payload) => {
      callback(payload.payload as GachaBroadcastPayload)
    })
    .subscribe()

  return () => {
    client.removeChannel(channel)
  }
}
