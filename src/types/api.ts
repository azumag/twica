export interface ApiErrorResponse {
  error: string
  retryAfter?: number
}

export interface ApiRateLimitResponse extends ApiErrorResponse {
  error: string
  retryAfter: number
}

export interface UploadApiResponse {
  url: string
}

export interface UploadApiErrorResponse extends ApiErrorResponse {
  error: string
}

export interface GachaSuccessResponse {
  card: {
    id: string
    name: string
    description: string | null
    image_url: string | null
    rarity: 'common' | 'rare' | 'epic' | 'legendary'
  }
}

export interface GachaErrorResponse extends ApiErrorResponse {
  error: string
}

export interface BattleSuccessResponse {
  battleId: string
  result: 'win' | 'lose' | 'draw'
  turnCount: number
  userCard: {
    id: string
    name: string
    hp: number
    currentHp: number
    atk: number
    def: number
    spd: number
    skill_type: 'attack' | 'defense' | 'heal' | 'special'
    skill_name: string
    image_url: string
    rarity: 'common' | 'rare' | 'epic' | 'legendary'
  }
  opponentCard: {
    id: string
    name: string
    hp: number
    currentHp: number
    atk: number
    def: number
    spd: number
    skill_type: 'attack' | 'defense' | 'heal' | 'special'
    skill_name: string
    image_url: string
    rarity: 'common' | 'rare' | 'epic' | 'legendary'
  }
  logs: Array<{
    round: number
    attacker: 'user' | 'opponent'
    action: string
    damage?: number
    heal?: number
    effect?: string
  }>
}

export interface BattleErrorResponse extends ApiErrorResponse {
  error: string
}

export interface CardResponse {
  id: string
  streamer_id: string
  name: string
  description: string | null
  image_url: string | null
  rarity: 'common' | 'rare' | 'epic' | 'legendary'
  drop_rate: number
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface CardsSuccessResponse {
  cards: CardResponse[]
}

export interface CardSuccessResponse {
  card: CardResponse
}

export interface CardsErrorResponse extends ApiErrorResponse {
  error: string
}

export interface DeleteSuccessResponse {
  success: true
}