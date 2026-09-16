import { describe, expect, it } from 'vitest'

import {
  getFileExtension,
  getSoundFileTypeFromBuffer,
  isValidSoundExtension,
} from '@/lib/file-utils'

describe('sound file utils', () => {
  describe('getSoundFileTypeFromBuffer', () => {
    it('ID3 ヘッダー付き MP3 を audio/mpeg と判定する', () => {
      const buffer = Buffer.from([
        0x49, 0x44, 0x33, 0x04, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ])

      expect(getSoundFileTypeFromBuffer(buffer)).toBe('audio/mpeg')
    })

    it.each([0xfb, 0xfa, 0xf3, 0xf2])(
      'MPEG frame header 0xFF 0x%s を audio/mpeg と判定する',
      (secondByte) => {
        const buffer = Buffer.from([
          0xff, secondByte, 0x00, 0x00, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ])

        expect(getSoundFileTypeFromBuffer(buffer)).toBe('audio/mpeg')
      },
    )

    it('RIFF/WAVE ヘッダーを audio/wav と判定する', () => {
      const buffer = Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x00, 0x00,
        0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
      ])

      expect(getSoundFileTypeFromBuffer(buffer)).toBe('audio/wav')
    })

    it('EBML ヘッダーを audio/webm と判定する', () => {
      const buffer = Buffer.from([
        0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ])

      expect(getSoundFileTypeFromBuffer(buffer)).toBe('audio/webm')
    })

    it('OggS ヘッダーを audio/ogg と判定する', () => {
      const buffer = Buffer.from([
        0x4f, 0x67, 0x67, 0x53, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ])

      expect(getSoundFileTypeFromBuffer(buffer)).toBe('audio/ogg')
    })

    it('未知の 12 byte ヘッダーは application/octet-stream に落とす', () => {
      expect(getSoundFileTypeFromBuffer(Buffer.alloc(12))).toBe(
        'application/octet-stream',
      )
    })

    it('12 byte 未満の buffer は application/octet-stream に落とす', () => {
      expect(getSoundFileTypeFromBuffer(Buffer.from([0x49, 0x44, 0x33]))).toBe(
        'application/octet-stream',
      )
    })
  })

  describe('getFileExtension', () => {
    it('最終拡張子を小文字化して返す', () => {
      expect(getFileExtension('voice.final.MP3')).toBe('mp3')
      expect(getFileExtension('sound.OGG')).toBe('ogg')
    })

    it('拡張子がない場合は空文字を返す', () => {
      expect(getFileExtension('sound')).toBe('')
    })
  })

  describe('isValidSoundExtension', () => {
    it.each(['mp3', 'wav', 'webm', 'ogg'])(
      '許可拡張子 %s を受理する',
      (extension) => {
        expect(isValidSoundExtension(extension)).toBe(true)
      },
    )

    it.each(['png', 'exe', ''])('非許可拡張子 %s を拒否する', (extension) => {
      expect(isValidSoundExtension(extension)).toBe(false)
    })
  })
})
