import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import CardMedia from '@/components/CardMedia'

// CardMedia の thumbnail/icon (controls=false) と OBS本表示 (controls=true) で
// video の autoplay/loop/muted 挙動が切り替わることを検証する。
// (PR #449 レビュー指摘 #3 動画が黒画面 への対応を担保)
describe('CardMedia', () => {
  it('renders an <img> for image media type', () => {
    const { container } = render(
      <CardMedia
        url="https://example.com/foo.png"
        mediaType="image"
        alt="card"
        width={100}
        height={100}
      />,
    )
    expect(container.querySelector('img')).not.toBeNull()
    expect(container.querySelector('video')).toBeNull()
  })

  it('autoplays muted looped video for thumbnail use (controls=false)', () => {
    const { container } = render(
      <CardMedia
        url="https://example.com/foo.mp4"
        mediaType="video"
        alt="card"
        width={100}
        height={100}
      />,
    )
    const video = container.querySelector('video')
    expect(video).not.toBeNull()
    if (!video) return
    expect(video.hasAttribute('autoplay')).toBe(true)
    expect(video.hasAttribute('loop')).toBe(true)
    expect(video.hasAttribute('muted')).toBe(true)
    expect(video.hasAttribute('playsinline')).toBe(true)
    expect(video.getAttribute('preload')).toBe('metadata')
    expect(video.hasAttribute('controls')).toBe(false)
  })

  it('does not autoplay when controls are enabled (OBS overlay use)', () => {
    const { container } = render(
      <CardMedia
        url="https://example.com/foo.mp4"
        mediaType="video"
        alt="card"
        width={100}
        height={100}
        controls
      />,
    )
    const video = container.querySelector('video')
    expect(video).not.toBeNull()
    if (!video) return
    expect(video.hasAttribute('controls')).toBe(true)
    expect(video.hasAttribute('autoplay')).toBe(false)
    expect(video.hasAttribute('loop')).toBe(false)
    expect(video.hasAttribute('muted')).toBe(false)
  })
})
