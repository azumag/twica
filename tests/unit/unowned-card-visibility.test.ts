import { describe, expect, it } from 'vitest';
import {
  HIDDEN_UNOWNED_CARD_ITEM_VISIBILITY,
  allUnownedCardItemsVisible,
  mirrorUnownedCardDetails,
  resolveUnownedCardVisibility,
  type UnownedCardVisibilityRow,
} from '@/lib/unowned-card-visibility';

/**
 * Issue #2070 フォローアップ: 未所持カードの項目別公開判定。
 * resolve の規則 a〜d を分岐ごとに固定する。ここが崩れると、配信者が
 * 非公開にした名前・画像・説明がコレクション画面や RSC ペイロードへ漏れる。
 */

const ALL_VISIBLE = { name: true, image: true, description: true };
const ALL_HIDDEN = { name: false, image: false, description: false };

function row(
  overrides: Partial<UnownedCardVisibilityRow> = {},
): UnownedCardVisibilityRow {
  return {
    show_unowned_cards: true,
    show_unowned_card_details: false,
    show_unowned_card_name: false,
    show_unowned_card_image: false,
    show_unowned_card_description: false,
    ...overrides,
  };
}

describe('resolveUnownedCardVisibility 規則a: マスタースイッチ', () => {
  it.each([false, null, undefined])(
    'show_unowned_cards=%s なら新3列がすべて true でも全項目 false',
    (master) => {
      // 規則a: 未所持カードを表示しない配信者では、項目別フラグが過去の設定で
      // true のまま残っていても何も公開しない（最上位の設定が常に優先）。
      expect(
        resolveUnownedCardVisibility(
          row({
            show_unowned_cards: master,
            show_unowned_card_details: true,
            show_unowned_card_name: true,
            show_unowned_card_image: true,
            show_unowned_card_description: true,
          }),
        ),
      ).toEqual(ALL_HIDDEN);
    },
  );

  it('show_unowned_cards=true のときだけ項目別フラグを評価する', () => {
    expect(
      resolveUnownedCardVisibility(
        row({
          show_unowned_cards: true,
          show_unowned_card_details: true,
          show_unowned_card_name: true,
          show_unowned_card_image: true,
          show_unowned_card_description: true,
        }),
      ),
    ).toEqual(ALL_VISIBLE);
  });
});

describe('resolveUnownedCardVisibility 規則b: 新3列が取得できないデプロイ窓', () => {
  it('新3列がすべて undefined なら旧 details=true から3項目すべて true を導出する', () => {
    // STREAMERS_SAFE_COLUMNS へ縮退した再試行側の行を想定（新3列が存在しない）。
    // migration 適用前でも旧設定どおりの公開内容を維持する互換経路。
    const legacyRow = {
      show_unowned_cards: true,
      show_unowned_card_details: true,
    } as UnownedCardVisibilityRow;

    expect(resolveUnownedCardVisibility(legacyRow)).toEqual(ALL_VISIBLE);
  });

  it.each([false, null, undefined])(
    '新3列がすべて undefined かつ旧 details=%s なら全項目 false（fail-closed）',
    (details) => {
      // 旧設定が明示 true でない限り、列欠落時は何も公開しない。
      const legacyRow = {
        show_unowned_cards: true,
        show_unowned_card_details: details,
      } as UnownedCardVisibilityRow;

      expect(resolveUnownedCardVisibility(legacyRow)).toEqual(ALL_HIDDEN);
    },
  );

  it.each([null, undefined])(
    '新3列が null（%s）でも旧 details=true から導出する',
    (missing) => {
      expect(
        resolveUnownedCardVisibility(
          row({
            show_unowned_card_details: true,
            show_unowned_card_name: missing,
            show_unowned_card_image: missing,
            show_unowned_card_description: missing,
          }),
        ),
      ).toEqual(ALL_VISIBLE);
    },
  );

  it.each(['show_unowned_card_name', 'show_unowned_card_image', 'show_unowned_card_description'] as const)(
    '%s だけが欠落していても3列まとめて旧 details から導出する（部分採用しない）',
    (missingColumn) => {
      // 新3列は1 migration で同時に追加されるため通常は同時に欠落するが、
      // 部分的に欠けた状態で残りを採用すると、配信者が設定していない項目を
      // 公開し得る。all-or-nothing で旧設定へ倒す。
      expect(
        resolveUnownedCardVisibility(
          row({
            show_unowned_card_details: true,
            [missingColumn]: undefined,
          }),
        ),
      ).toEqual(ALL_VISIBLE);
      expect(
        resolveUnownedCardVisibility(
          row({
            show_unowned_card_details: false,
            [missingColumn]: null,
          }),
        ),
      ).toEqual(ALL_HIDDEN);
    },
  );
});

describe('resolveUnownedCardVisibility 規則c: 旧アプリの OFF 取りこぼしガード', () => {
  it('details=false かつ新3列がすべて true なら全項目 false', () => {
    // 新アプリは details = name && image && description をミラーするため、
    // この組み合わせは旧アプリで詳細公開を OFF にした場合にしか生じない。
    // 配信者が切った設定を復活させない。
    expect(
      resolveUnownedCardVisibility(
        row({
          show_unowned_card_details: false,
          show_unowned_card_name: true,
          show_unowned_card_image: true,
          show_unowned_card_description: true,
        }),
      ),
    ).toEqual(ALL_HIDDEN);
  });

  it.each([
    ['name', { name: true, image: false, description: false }],
    ['image', { name: false, image: true, description: false }],
    ['description', { name: false, image: false, description: true }],
    ['name+image', { name: true, image: true, description: false }],
    ['name+description', { name: true, image: false, description: true }],
    ['image+description', { name: false, image: true, description: true }],
  ] as const)(
    '部分公開（%s）はミラーで details=false になる正当な状態なので潰さない',
    (_label, partial) => {
      // ガードは「全 true」のときだけ。部分公開まで false にすると、新アプリで
      // 設定した項目別公開が旧列に巻き戻されてしまう。
      expect(
        resolveUnownedCardVisibility(
          row({
            show_unowned_card_details: false,
            show_unowned_card_name: partial.name,
            show_unowned_card_image: partial.image,
            show_unowned_card_description: partial.description,
          }),
        ),
      ).toEqual(partial);
    },
  );

  it.each([null, undefined])('details=%s（明示 false ではない）ならガードしない', (details) => {
    expect(
      resolveUnownedCardVisibility(
        row({
          show_unowned_card_details: details,
          show_unowned_card_name: true,
          show_unowned_card_image: true,
          show_unowned_card_description: true,
        }),
      ),
    ).toEqual(ALL_VISIBLE);
  });
});

describe('resolveUnownedCardVisibility 規則d: 新3列の採用', () => {
  it.each([
    { name: true, image: true, description: true },
    { name: true, image: false, description: false },
    { name: false, image: true, description: false },
    { name: false, image: false, description: true },
    { name: true, image: true, description: false },
    { name: false, image: true, description: true },
    { name: false, image: false, description: false },
  ])('details=true でも新3列 $name/$image/$description をそのまま採用する', (items) => {
    expect(
      resolveUnownedCardVisibility(
        row({
          show_unowned_card_details: true,
          show_unowned_card_name: items.name,
          show_unowned_card_image: items.image,
          show_unowned_card_description: items.description,
        }),
      ),
    ).toEqual(items);
  });

  it.each([null, undefined])(
    '新3列が boolean としてそろっていれば details=%s でも新3列を採用する',
    (details) => {
      expect(
        resolveUnownedCardVisibility(
          row({
            show_unowned_card_details: details,
            show_unowned_card_name: true,
            show_unowned_card_image: false,
            show_unowned_card_description: true,
          }),
        ),
      ).toEqual({ name: true, image: false, description: true });
    },
  );
});

describe('mirrorUnownedCardDetails', () => {
  it.each([
    [{ name: true, image: true, description: true }, true],
    [{ name: true, image: true, description: false }, false],
    [{ name: true, image: false, description: true }, false],
    [{ name: false, image: true, description: true }, false],
    [{ name: true, image: false, description: false }, false],
    [{ name: false, image: false, description: false }, false],
  ] as const)('3項目の AND を旧 details へミラーする: %o -> %s', (items, expected) => {
    // C4 の設定 API が旧列へ書く値。部分公開では false になり、旧アプリでは
    // 詳細非公開として扱われる。
    expect(mirrorUnownedCardDetails(items)).toBe(expected);
  });
});

describe('allUnownedCardItemsVisible', () => {
  it('3項目すべて true のときだけ true', () => {
    expect(allUnownedCardItemsVisible(ALL_VISIBLE)).toBe(true);
    expect(
      allUnownedCardItemsVisible({ name: true, image: true, description: false }),
    ).toBe(false);
    expect(
      allUnownedCardItemsVisible({ name: false, image: true, description: true }),
    ).toBe(false);
    expect(allUnownedCardItemsVisible(ALL_HIDDEN)).toBe(false);
  });
});

describe('HIDDEN_UNOWNED_CARD_ITEM_VISIBILITY', () => {
  it('全項目非公開の既定値で、書き換えできない', () => {
    expect(HIDDEN_UNOWNED_CARD_ITEM_VISIBILITY).toEqual(ALL_HIDDEN);
    expect(Object.isFrozen(HIDDEN_UNOWNED_CARD_ITEM_VISIBILITY)).toBe(true);
  });

  it('resolve の返り値を書き換えても共有定数に影響しない', () => {
    const resolved = resolveUnownedCardVisibility(row());
    resolved.name = true;
    expect(HIDDEN_UNOWNED_CARD_ITEM_VISIBILITY.name).toBe(false);
  });
});
