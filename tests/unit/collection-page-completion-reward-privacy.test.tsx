import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card } from '@/types/database';

const fixtures = vi.hoisted(() => ({
  streamer: {
    id: 'streamer',
    twitch_display_name: 'Streamer',
    card_pack_names: ['A'],
    show_unowned_cards: false as boolean,
    show_unowned_card_details: false as boolean | null | undefined,
    // Issue #2070 フォローアップ: 項目別公開。既定は undefined（旧 details から導出）。
    show_unowned_card_name: undefined as boolean | null | undefined,
    show_unowned_card_image: undefined as boolean | null | undefined,
    show_unowned_card_description: undefined as boolean | null | undefined,
  },
  owned: {} as Card & { count: number },
  views: [] as Array<{ collectionName: string; state: 'locked' | 'granted' | 'grantedNow'; rarity?: string; card?: Card }>,
}));

vi.mock('@/lib/session', () => ({ getSession: async () => ({ twitchUserId: 'viewer' }) }));
vi.mock('@/lib/dashboard-data', () => ({
  getStreamerById: async () => fixtures.streamer,
  getUserCardsForStreamer: async () => [fixtures.owned],
  getActiveCardsForStreamer: async () => [fixtures.owned],
  // 表示番号の入力は「その配信者の全カード（無効化含む）」。
  getAllCardsForStreamer: async () => [fixtures.owned],
  getCollectionCompletions: async () => [],
  recordCollectionCompletion: vi.fn(),
  recordPackCompletion: vi.fn(),
}));
vi.mock('@/lib/services/pack-completion-reward', () => ({
  applyPackCompletionRewards: async () => ({ views: fixtures.views, cards: [fixtures.owned], rewardCardIds: [] }),
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/components/SortedCardGrid', () => ({ default: () => null }));
vi.mock('@/components/CollectionPackFilter', () => ({ default: () => null }));

import Page from '@/app/collection/[streamerId]/page';

function card(id: string): Card {
  return {
    id,
    streamer_id: 'streamer',
    name: `${id} secret name`,
    description: `${id} secret description`,
    image_url: `https://example.test/${id}-secret.png`,
    image_padding_color: '#123456',
    rarity: 'rare',
    card_number: 13,
    max_issuance_count: 100,
    issued_count: 7,
    collection_name: 'A',
    drop_rate: 10,
    intra_rarity_weight: 2,
    is_active: true,
    hp: 20,
    atk: 30,
    def: 40,
    spd: 50,
    skill_type: 'heal',
    skill_name: `${id} secret skill`,
    skill_power: 60,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-02-01T00:00:00Z',
  };
}

const SECRET = 'GRANTED_SECRET';

beforeEach(() => {
  fixtures.streamer.show_unowned_cards = false;
  fixtures.streamer.show_unowned_card_details = false;
  fixtures.streamer.show_unowned_card_name = undefined;
  fixtures.streamer.show_unowned_card_image = undefined;
  fixtures.streamer.show_unowned_card_description = undefined;
  fixtures.owned = { ...card('owned'), count: 3 } as Card & { count: number };
  fixtures.views = [
    { collectionName: 'A', state: 'granted', card: card(SECRET) } as any,
  ];
});

const renderPage = () => Page({ params: Promise.resolve({ streamerId: 'streamer' }) });

describe('collection page completionReward privacy boundary', () => {
  it('does NOT leak granted-but-unowned reward card name/image_url/description (both settings off)', async () => {
    fixtures.streamer.show_unowned_cards = false;
    fixtures.streamer.show_unowned_card_details = false;
    const page = await renderPage();

    const rewards = page.props.completionRewards as any[];
    // view must be dropped because the reward card is neither owned nor explicitly published
    expect(rewards).toEqual([]);
    const serialized = JSON.stringify(rewards);
    for (const secret of [`${SECRET} secret name`, `${SECRET} secret description`, `https://example.test/${SECRET}-secret.png`]) {
      expect(serialized, secret).not.toContain(secret);
    }
  });

  it('keeps granted-but-unowned reward when both show_unowned flags are explicitly on', async () => {
    fixtures.streamer.show_unowned_cards = true;
    fixtures.streamer.show_unowned_card_details = true;
    const page = await renderPage();

    const rewards = page.props.completionRewards as any[];
    expect(rewards).toHaveLength(1);
    expect(rewards[0].state).toBe('granted');
    expect(rewards[0].card.id).toBe(SECRET);
  });

  it('keeps granted reward when the reward card is currently owned (count>0)', async () => {
    fixtures.owned = { ...card(SECRET), count: 2 } as Card & { count: number };
    fixtures.streamer.show_unowned_cards = false;
    fixtures.streamer.show_unowned_card_details = false;
    const page = await renderPage();

    const rewards = page.props.completionRewards as any[];
    expect(rewards).toHaveLength(1);
    expect(rewards[0].card.id).toBe(SECRET);
  });

  it('always keeps locked (rarity-only) views regardless of ownership', async () => {
    fixtures.views = [{ collectionName: 'B', state: 'locked', rarity: 'legendary' } as any];
    const page = await renderPage();
    const rewards = page.props.completionRewards as any[];
    expect(rewards).toHaveLength(1);
    expect(rewards[0].state).toBe('locked');
  });

  it('drops granted-but-unowned reward when only some items are public (保守的な全項目公開条件)', async () => {
    // Issue #2070 フォローアップ: 部分公開のカードを報酬一覧へ渡すと、非公開項目の
    // 実値が報酬オブジェクト経由で RSC ペイロードに載る。既存挙動を保つため、
    // 「3項目すべて公開」のときだけ未所持報酬を残す。
    fixtures.streamer.show_unowned_cards = true;
    fixtures.streamer.show_unowned_card_details = false;
    fixtures.streamer.show_unowned_card_name = true;
    fixtures.streamer.show_unowned_card_image = true;
    fixtures.streamer.show_unowned_card_description = false;
    const page = await renderPage();

    const rewards = page.props.completionRewards as any[];
    expect(rewards).toEqual([]);
    const serialized = JSON.stringify(rewards);
    for (const secret of [`${SECRET} secret name`, `${SECRET} secret description`, `https://example.test/${SECRET}-secret.png`]) {
      expect(serialized, secret).not.toContain(secret);
    }
  });
});
