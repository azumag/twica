import { isCanonicalUuid } from "@/lib/uuid-validation"

const OVERLAY_EVENTS_PATH_PATTERN = /^\/api\/overlay\/([^/]+)\/events\/?$/

/**
 * Overlay events API の動的 streamerId がUUIDとして不正かを判定する。
 *
 * 対象外のパスは false を返す。対象パスでURLデコード不能、またはUUID形式で
 * ない場合だけ true を返し、middlewareでDBアクセス前に400へ変換する。
 */
export function hasInvalidOverlayEventsStreamerId(pathname: string): boolean {
  const match = pathname.match(OVERLAY_EVENTS_PATH_PATTERN)
  if (!match) return false

  let streamerId: string
  try {
    streamerId = decodeURIComponent(match[1])
  } catch {
    return true
  }

  return !isCanonicalUuid(streamerId)
}
