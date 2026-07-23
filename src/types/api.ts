import type { Rarity } from './database'

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
    rarity: Rarity
  }
}

export interface GachaErrorResponse extends ApiErrorResponse {
  error: string
}

export interface CardResponse {
  id: string
  streamer_id: string
  name: string
  description: string | null
  image_url: string | null
  rarity: Rarity
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
