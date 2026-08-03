import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

describe('settings chat delivery capability contract', () => {
  it('server helperのneedsAttentionをbannerとsettings sidebarへ再計算せず渡す', () => {
    const dashboardLayoutSource = readSource('src/app/dashboard/layout.tsx')
    const pageSource = readSource('src/app/dashboard/settings/page.tsx')
    const layoutSource = readSource('src/components/SettingsLayout.tsx')

    // helper失敗時は canSendChat=false でも needsAttention=false になる。途中で
    // enabled && !canSendChat を再構築するとfalse-positiveが復活するため、serverで
    // 確定したbooleanをbanner・prop境界・sidebar判定の全てで直接使う契約を固定する。
    expect(dashboardLayoutSource).toContain(
      'ChatDeliveryWarning needsAttention={chatDeliveryCapability?.needsAttention ?? false}',
    )
    expect(pageSource).toContain('needsAttention: chatDeliveryCapability.needsAttention')
    expect(pageSource).not.toContain('deliveryAvailable: chatDeliveryCapability.canSendChat')
    expect(layoutSource).toContain(
      'const announcementNeedsAttention = data.chatAnnouncement.needsAttention;',
    )
    expect(layoutSource).not.toContain(
      'data.chatAnnouncement.enabled && !data.chatAnnouncement.deliveryAvailable',
    )
  })
})
