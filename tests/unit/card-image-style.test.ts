import { describe, expect, it } from 'vitest'
import { cardImageFitClass, cardImageFitStyle } from '@/lib/card-image-style'

describe('card-image-style', () => {
  it('paddingなしの従来カードはcover表示と背景styleなしを維持する', () => {
    for (const paddingColor of [null, undefined, '']) {
      expect(cardImageFitClass(paddingColor)).toBe('object-cover')
      expect(cardImageFitStyle(paddingColor)).toBeUndefined()
    }
  })

  it('padding色ありのfitカードはcontain表示と指定背景色を使う', () => {
    expect(cardImageFitClass('#1a2b3c')).toBe('object-contain')
    expect(cardImageFitStyle('#1a2b3c')).toEqual({
      backgroundColor: '#1a2b3c',
    })
  })

  it('transparentもfitカードとしてcontain表示を維持する', () => {
    expect(cardImageFitClass('transparent')).toBe('object-contain')
    expect(cardImageFitStyle('transparent')).toEqual({
      backgroundColor: 'transparent',
    })
  })
})
