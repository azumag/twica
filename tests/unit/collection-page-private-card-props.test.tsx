import { isValidElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card } from '@/types/database';

const fixtures = vi.hoisted(() => ({
  streamer: {
    id: 'streamer',
    twitch_display_name: 'Streamer',
    card_pack_names: ['A'],
    show_unowned_cards: true,
    show_unowned_card_details: false as boolean | null | undefined,
    // Issue #2070 フォローアップ: 新3列はデプロイ窓では undefined になるため、
    // 既定は undefined（旧 details から導出）にしておく。
    show_unowned_card_name: undefined as boolean | null | undefined,
    show_unowned_card_image: undefined as boolean | null | undefined,
    show_unowned_card_description: undefined as boolean | null | undefined,
  },
  owned: {} as Card & { count: number },
  unowned: {} as Card & { private_metadata: { secret: string } },
}));

vi.mock('@/lib/session', () => ({ getSession: async () => ({ twitchUserId: 'viewer' }) }));
vi.mock('@/lib/dashboard-data', () => ({
  getStreamerById: async () => fixtures.streamer,
  getUserCardsForStreamer: async () => [fixtures.owned],
  getActiveCardsForStreamer: async () => [fixtures.owned, fixtures.unowned],
  getCollectionCompletions: async () => [],
  recordCollectionCompletion: vi.fn(),
  recordPackCompletion: vi.fn(),
}));
vi.mock('@/lib/services/pack-completion-reward', () => ({
  applyPackCompletionRewards: async () => ({ views: [], cards: [fixtures.owned], rewardCardIds: [] }),
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
// Keep the actual server component so both Server -> Client boundaries are checked.
vi.mock('@/components/SortedCardGrid', () => ({ default: () => null }));
vi.mock('@/components/CollectionPackFilter', () => ({ default: () => null }));

import Page from '@/app/collection/[streamerId]/page';
import StreamerCollection from '@/components/StreamerCollection';
import SortedCardGrid from '@/components/SortedCardGrid';
import CollectionPackFilter from '@/components/CollectionPackFilter';

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

beforeEach(() => {
  fixtures.streamer.show_unowned_cards = true;
  fixtures.streamer.show_unowned_card_details = false;
  fixtures.streamer.show_unowned_card_name = undefined;
  fixtures.streamer.show_unowned_card_image = undefined;
  fixtures.streamer.show_unowned_card_description = undefined;
  fixtures.streamer.card_pack_names = ['A'];
  fixtures.owned = { ...card('owned'), count: 3 };
  fixtures.unowned = {
    ...card('unowned'),
    card_number: 21,
    rarity: 'common',
    private_metadata: { secret: 'unowned future private field' },
  };
});

const renderPage = () => Page({ params: Promise.resolve({ streamerId: 'streamer' }) });

function expectPrivatePlaceholder(cards: Card[]) {
  const unowned = cards.find((entry) => entry.id === 'unowned');
  expect(unowned).toMatchObject({
    name: '',
    image_url: null,
    description: null,
    image_padding_color: null,
    max_issuance_count: null,
    skill_name: '',
    updated_at: '',
    drop_rate: 0,
    intra_rarity_weight: 0,
    hp: 0,
    atk: 0,
    def: 0,
    spd: 0,
    skill_type: 'attack',
    skill_power: 0,
  });
  expect(unowned).not.toHaveProperty('issued_count');
  expect(unowned).not.toHaveProperty('private_metadata');
  const serialized = JSON.stringify(cards);
  for (const secret of [
    fixtures.unowned.name,
    fixtures.unowned.description,
    fixtures.unowned.image_url,
    fixtures.unowned.skill_name,
    fixtures.unowned.private_metadata.secret,
  ]) {
    expect(serialized).not.toContain(secret);
  }
}

describe('collection page private unowned card props', () => {
  it.each([false, null, undefined])('does not serialize unowned details when disclosure is %s', async (details) => {
    fixtures.streamer.show_unowned_card_details = details;
    const page = await renderPage();

    expectPrivatePlaceholder(page.props.cards);
    expect(page.props.unownedCardVisibility).toEqual({
      name: false,
      image: false,
      description: false,
    });
    expect(page.props.cards.find((entry: Card) => entry.id === 'unowned')).toMatchObject({
      id: 'unowned',
      streamer_id: 'streamer',
      rarity: 'common',
      card_number: 21,
      collectionNumber: 21,
      collection_name: 'A',
      is_active: true,
      created_at: fixtures.unowned.created_at,
      count: 0,
      isOwned: false,
    });
    // Ownership, progress and pack metadata must remain useful for placeholders.
    expect(page.props.cards.find((entry: Card) => entry.id === 'owned')).toMatchObject({
      ...fixtures.owned,
      isOwned: true,
      collectionNumber: 13,
    });
    expect(page.props.stats).toEqual({
      total: 3, unique: 1, legendary: 0, epic: 0, rare: 1, common: 0, customRarities: [],
    });
    expect(page.props.progress).toEqual({ owned: 1, total: 2 });
    expect(page.props.visibleCardTypes).toBe(2);
    expect(page.props.packs).toEqual([{
      key: 'A', displayName: 'A', progress: { owned: 1, total: 2 }, completionHistory: [],
    }]);
  });

  it('retains unowned details when all three items are explicitly enabled', async () => {
    fixtures.streamer.show_unowned_card_details = true;
    fixtures.streamer.show_unowned_card_name = true;
    fixtures.streamer.show_unowned_card_image = true;
    fixtures.streamer.show_unowned_card_description = true;
    const page = await renderPage();

    expect(page.props.unownedCardVisibility).toEqual({
      name: true,
      image: true,
      description: true,
    });
    expect(page.props.cards.find((entry: Card) => entry.id === 'unowned')).toMatchObject({
      id: fixtures.unowned.id,
      streamer_id: fixtures.unowned.streamer_id,
      rarity: fixtures.unowned.rarity,
      card_number: fixtures.unowned.card_number,
      collection_name: fixtures.unowned.collection_name,
      is_active: fixtures.unowned.is_active,
      created_at: fixtures.unowned.created_at,
      name: fixtures.unowned.name,
      image_url: fixtures.unowned.image_url,
      description: fixtures.unowned.description,
      image_padding_color: fixtures.unowned.image_padding_color,
      // ステータスは項目別公開の対象外なので、全公開でも常に中立値。
      hp: 0,
      atk: 0,
      def: 0,
      spd: 0,
      skill_type: 'attack',
      skill_name: '',
      skill_power: 0,
      count: 0,
      isOwned: false,
      collectionNumber: 21,
    });
  });

  /**
   * Issue #2070 フォローアップ: 項目別の組合せで、非公開項目の実値が RSC
   * ペイロードに残らないことを固定する。details は C4 のミラー
   * （name && image && description）を再現する。
   */
  const itemCombinations = [
    { name: false, image: false, description: false },
    { name: true, image: false, description: false },
    { name: false, image: true, description: false },
    { name: false, image: false, description: true },
    { name: true, image: true, description: false },
    { name: true, image: false, description: true },
    { name: false, image: true, description: true },
    { name: true, image: true, description: true },
  ];

  it('excludes unowned cards when their visibility is disabled', async () => {
    fixtures.streamer.show_unowned_cards = false;
    fixtures.streamer.show_unowned_card_details = true;
    const page = await renderPage();

    expect(page.props.cards.map((entry: Card) => entry.id)).toEqual(['owned']);
    expect(page.props.visibleCardTypes).toBe(1);
    expect(page.props.progress).toEqual({ owned: 1, total: 2 });
  });

  it('does not mutate the active card source while constructing placeholders', async () => {
    const original = structuredClone(fixtures.unowned);
    await renderPage();
    expect(fixtures.unowned).toEqual(original);
  });

  it.each([false, true])('keeps secrets out of the client boundary with named packs=%s', async (namedPacks) => {
    if (!namedPacks) {
      fixtures.streamer.card_pack_names = [];
      fixtures.owned.collection_name = null;
      fixtures.unowned.collection_name = null;
    }
    const page = await renderPage();
    const serverTree = await StreamerCollection(page.props);
    const target = namedPacks ? CollectionPackFilter : SortedCardGrid;
    const boundaries: Card[][] = [];
    function visit(node: ReactNode): void {
      if (Array.isArray(node)) {
        node.forEach(visit);
      } else if (isValidElement<{ cards?: Card[]; children?: ReactNode }>(node)) {
        if (node.type === target && node.props.cards) boundaries.push(node.props.cards);
        visit(node.props.children);
      }
    }
    visit(serverTree);

    expect(boundaries).toHaveLength(1);
    expectPrivatePlaceholder(boundaries[0]);
  });

  it.each(itemCombinations)(
    '項目別の組合せ $name/$image/$description で非公開項目の実値だけを落とす',
    async (visibility) => {
      fixtures.streamer.show_unowned_card_details =
        visibility.name && visibility.image && visibility.description;
      fixtures.streamer.show_unowned_card_name = visibility.name;
      fixtures.streamer.show_unowned_card_image = visibility.image;
      fixtures.streamer.show_unowned_card_description = visibility.description;

      const page = await renderPage();
      const unowned = page.props.cards.find((entry: Card) => entry.id === 'unowned');

      expect(page.props.unownedCardVisibility).toEqual(visibility);
      expect(unowned.name).toBe(visibility.name ? fixtures.unowned.name : '');
      expect(unowned.image_url).toBe(
        visibility.image ? fixtures.unowned.image_url : null,
      );
      expect(unowned.description).toBe(
        visibility.description ? fixtures.unowned.description : null,
      );
      // 画像非公開時は余白色も落とす（画像の表示属性のため）。
      expect(unowned.image_padding_color).toBe(
        visibility.image ? fixtures.unowned.image_padding_color : null,
      );

      const serialized = JSON.stringify(page.props.cards);
      const secrets = [
        [visibility.name, fixtures.unowned.name],
        [visibility.image, fixtures.unowned.image_url],
        [visibility.description, fixtures.unowned.description],
      ] as const;
      for (const [visible, secret] of secrets) {
        if (visible) {
          expect(serialized).toContain(secret);
        } else {
          expect(serialized).not.toContain(secret);
        }
      }
      // 設定対象外の実値（スキル名・将来列）は全公開でもペイロードへ載せない。
      expect(serialized).not.toContain(fixtures.unowned.skill_name);
      expect(serialized).not.toContain(fixtures.unowned.private_metadata.secret);
    },
  );
});