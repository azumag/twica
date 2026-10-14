import { describe, expect, it } from 'vitest'
import {
  ALBUM_ALL_PACKS_KEY,
  ALBUM_GRID_SIZES,
  DEFAULT_ALBUM_GRID_SIZE,
  isReservedAlbumScopeKey,
  normalizeAlbumDefaultView,
  normalizeAlbumGridSize,
  pruneAlbumGridSizeMap,
  resolveAlbumGridSize,
  sanitizeAlbumGridSizeMap,
  validateAlbumGridSizeMap,
} from '@/lib/collection-album'

// #1765 フォローアップ: アルバムの並び (N×N) とパック別既定の共有ロジック。
// 表示側 (CardAlbumView / コレクションページ) と保存側 (POST /api/streamer/settings)
// が同じ規則を使うため、境界と正規化をここで固定する。
describe('collection-album', () => {
  describe('normalizeAlbumGridSize', () => {
    it('3..12 の整数だけを受け付ける', () => {
      expect(normalizeAlbumGridSize(3)).toBe(3)
      expect(normalizeAlbumGridSize(6)).toBe(6)
      expect(normalizeAlbumGridSize(12)).toBe(12)
    })

    it('範囲外・小数・非数値は null（呼び出し側が既定へ倒す）', () => {
      expect(normalizeAlbumGridSize(2)).toBeNull()
      expect(normalizeAlbumGridSize(13)).toBeNull()
      expect(normalizeAlbumGridSize(4.5)).toBeNull()
      expect(normalizeAlbumGridSize('6')).toBeNull()
      expect(normalizeAlbumGridSize(Number.NaN)).toBeNull()
      expect(normalizeAlbumGridSize(null)).toBeNull()
      expect(normalizeAlbumGridSize(undefined)).toBeNull()
    })

    it('選択肢は 3..12 の昇順で固定される', () => {
      expect(ALBUM_GRID_SIZES).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    })
  })

  describe('validateAlbumGridSizeMap', () => {
    const catalog = ['weapons', 'armors']

    it('予約キーとカタログ登録済みのパック名を許可する', () => {
      const result = validateAlbumGridSizeMap(
        { [ALBUM_ALL_PACKS_KEY]: 6, __default__: 3, weapons: 9 },
        catalog
      )
      expect(result).toEqual({
        ok: true,
        value: { [ALBUM_ALL_PACKS_KEY]: 6, __default__: 3, weapons: 9 },
      })
    })

    it('null は「全クリア」として許可する', () => {
      expect(validateAlbumGridSizeMap(null, catalog)).toEqual({ ok: true, value: null })
    })

    it('カタログに無いキーを拒否する（孤立キーを保存しない）', () => {
      expect(validateAlbumGridSizeMap({ unknown: 6 }, catalog)).toEqual({ ok: false })
    })

    it('カタログ未確定（空）では予約キーのみ許可する', () => {
      expect(validateAlbumGridSizeMap({ [ALBUM_ALL_PACKS_KEY]: 6 }, [])).toEqual({
        ok: true,
        value: { [ALBUM_ALL_PACKS_KEY]: 6 },
      })
      expect(validateAlbumGridSizeMap({ weapons: 6 }, [])).toEqual({ ok: false })
    })

    it('範囲外の値・非整数・配列・非オブジェクトを拒否する', () => {
      expect(validateAlbumGridSizeMap({ [ALBUM_ALL_PACKS_KEY]: 13 }, catalog)).toEqual({ ok: false })
      expect(validateAlbumGridSizeMap({ [ALBUM_ALL_PACKS_KEY]: '6' }, catalog)).toEqual({ ok: false })
      expect(validateAlbumGridSizeMap([6], catalog)).toEqual({ ok: false })
      expect(validateAlbumGridSizeMap('6', catalog)).toEqual({ ok: false })
    })
  })

  describe('pruneAlbumGridSizeMap', () => {
    it('カタログから消えたパックの設定だけを落とし、予約キーは残す', () => {
      const catalog = ['weapons']
      expect(
        pruneAlbumGridSizeMap(
          { [ALBUM_ALL_PACKS_KEY]: 6, __default__: 3, weapons: 9, gone: 12 },
          catalog
        )
      ).toEqual({ [ALBUM_ALL_PACKS_KEY]: 6, __default__: 3, weapons: 9 })
    })
  })

  describe('sanitizeAlbumGridSizeMap', () => {
    it('DB から読んだ壊れた値・未知の型は捨てて有効なエントリだけ残す', () => {
      expect(
        sanitizeAlbumGridSizeMap({ [ALBUM_ALL_PACKS_KEY]: 6, broken: '9', outOfRange: 99 })
      ).toEqual({ [ALBUM_ALL_PACKS_KEY]: 6 })
    })

    it('デプロイ窓の undefined / null / 配列は空マップへ縮退する', () => {
      expect(sanitizeAlbumGridSizeMap(undefined)).toEqual({})
      expect(sanitizeAlbumGridSizeMap(null)).toEqual({})
      expect(sanitizeAlbumGridSizeMap([6])).toEqual({})
    })
  })

  describe('resolveAlbumGridSize', () => {
    it('スコープ指定 → 「すべてのパック」 → 既定 3 の順にフォールバックする', () => {
      const sizes = { [ALBUM_ALL_PACKS_KEY]: 6, weapons: 9 }

      expect(resolveAlbumGridSize(sizes, 'weapons')).toBe(9)
      expect(resolveAlbumGridSize(sizes, 'armors')).toBe(6)
      expect(resolveAlbumGridSize(sizes, ALBUM_ALL_PACKS_KEY)).toBe(6)
      expect(resolveAlbumGridSize({}, 'weapons')).toBe(DEFAULT_ALBUM_GRID_SIZE)
      expect(resolveAlbumGridSize(null, 'weapons')).toBe(DEFAULT_ALBUM_GRID_SIZE)
      expect(resolveAlbumGridSize(undefined, ALBUM_ALL_PACKS_KEY)).toBe(DEFAULT_ALBUM_GRID_SIZE)
    })
  })

  describe('normalizeAlbumDefaultView', () => {
    it("'album' のときだけアルバム、不明値は fail-closed でカード表示", () => {
      expect(normalizeAlbumDefaultView('album')).toBe('album')
      expect(normalizeAlbumDefaultView('grid')).toBe('grid')
      expect(normalizeAlbumDefaultView(undefined)).toBe('grid')
      expect(normalizeAlbumDefaultView('unknown')).toBe('grid')
    })
  })

  describe('isReservedAlbumScopeKey', () => {
    it('__all__ と __default__ だけが予約キー', () => {
      expect(isReservedAlbumScopeKey(ALBUM_ALL_PACKS_KEY)).toBe(true)
      expect(isReservedAlbumScopeKey('__default__')).toBe(true)
      expect(isReservedAlbumScopeKey('weapons')).toBe(false)
    })
  })
})
