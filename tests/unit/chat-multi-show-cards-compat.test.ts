import { describe, expect, it, vi } from "vitest";

// Issue #1548: `chat_announcement_multi_show_cards` 廃止に向けた互換移行（bake）の
// 等価性テスト。migration `20261030120000_chat_multi_show_cards_bake.sql` が行う
// テンプレート焼き込みについて、「旧フラグ駆動の実効出力」と「焼き込み後テンプレートを
// プレースホルダー駆動で解決した出力」が一致することを、実装済みの buildMessage /
// fitCardNamesForMessage を使って検証する。
//
// 焼き込みロジックは SQL migration が正本であり、ここではその JS ミラーを
// `bakeMultiShowCards` として用意する（構造の一致は
// chat-multi-show-cards-bake-migration.test.ts が静的に固定する）。
import { TwitchChatService } from "@/lib/twitch/chat-service";
import {
  CARD_LIST_SEPARATOR,
  DEFAULT_MULTI_DRAW_CHAT_TEMPLATE,
  fitCardNamesForMessage,
} from "@/lib/services/eventsub-redemption";
import { countCharacters } from "@/lib/text-utils";

vi.mock("@/lib/env-validation", () => ({
  getEnvVar: vi.fn().mockReturnValue("test-client-id"),
}));

const chat = new TwitchChatService();

// DEFAULT テンプレートから {cards} を除いた、OFF+デフォルト利用者向けの焼き込み値。
// migration の CASE 1 WHEN 節のリテラルと同一であること（静的テストでも固定）。
const DEFAULT_TEMPLATE_WITHOUT_CARDS =
  "@{user} が{draws}連ガチャで {rarityCounts} を獲得しました！";

// eventsub-redemption.ts の multi-draw placeholder 判定と同じ集合。
// この6種のいずれかがあれば旧エンジンは「テンプレート内解決」とみなし、
// 無ければ flag ON 時に末尾へ「（全N枚: {cards}）」を暗黙追記していた。
const MULTI_DRAW_PLACEHOLDER_RE =
  /\{cards\}|\{draws\}|\{rarityCounts\}|\{newCards\}|\{newCardCount\}|\{newCardsOrNone\}/;
const NEW_CARD_PLACEHOLDER_RE = /\{newCards\}|\{newCardCount\}|\{newCardsOrNone\}/;

// SQL の REPLACE と同じ順序でカード名系 placeholder を除去する。
// ({newCards} は {newCardsOrNone} の部分文字列ではないため順序は結果に影響しない)
function stripCardNamePlaceholders(template: string): string {
  return template
    .replaceAll("{cards}", "")
    .replaceAll("{newCardsOrNone}", "")
    .replaceAll("{newCardCount}", "")
    .replaceAll("{newCards}", "");
}

// migration が実行する焼き込みの JS ミラー。戻り値は「書き込むべき新しい
// multi_template」（焼き込み不要なら元の値をそのまま返す）。
function bakeMultiShowCards(
  flag: boolean,
  multiTemplate: string | null,
): string | null {
  if (!flag) {
    // OFF + DEFAULT 使用: DEFAULT から {cards} を除いた明示テンプレート。
    // 空文字は `||` で DEFAULT 扱いされるため NULL と同じ経路。
    if (multiTemplate == null || multiTemplate === "") {
      return DEFAULT_TEMPLATE_WITHOUT_CARDS;
    }
    // OFF + カスタム: カード名系 placeholder のみ除去。
    // 除去結果が空白のみだと空文字へ `||` フォールバックしてしまうため、
    // trim で空出力を維持する半角空白1文字を書く（SQL 側は btrim 判定）。
    const stripped = stripCardNamePlaceholders(multiTemplate);
    return /^ *$/.test(stripped) ? " " : stripped;
  }
  // ON + カスタム + placeholder 非含有: 旧暗黙追記と等価な
  // 「（全{draws}枚: {cards}）」を焼き込む。'' は DEFAULT 扱いで対象外。
  if (
    multiTemplate != null &&
    multiTemplate !== "" &&
    !MULTI_DRAW_PLACEHOLDER_RE.test(multiTemplate)
  ) {
    return `${multiTemplate}（全{draws}枚: {cards}）`;
  }
  // ON + DEFAULT / ON + placeholder 含有: 変更不要。
  return multiTemplate;
}

// 通知生成に必要な変数一式。placeholder 値は新旧で同じ入力を使う。
interface DrawInput {
  drawnCards: string[]; // 今回引いた全カード名（{cards}・「全N枚」追記用）
  newCardNames: string[]; // 今回初めて獲得したカード名
  newCardInfoResolved: boolean; // {newCardsOrNone} の fail-closed 判定
  rarityCounts: string;
}

// 旧エンジン（preview 現行）のメッセージ構築ロジックを、実装と同じ分岐で写す。
// `flag` は旧 `chat_announcement_multi_show_cards`。
function legacyAnnounce(
  flag: boolean,
  multiTemplate: string | null,
  input: DrawInput,
): string {
  const messageTemplate = multiTemplate || DEFAULT_MULTI_DRAW_CHAT_TEMPLATE;
  const usesMultiDrawPlaceholders = MULTI_DRAW_PLACEHOLDER_RE.test(messageTemplate);
  const usesNewCardPlaceholders = NEW_CARD_PLACEHOLDER_RE.test(messageTemplate);
  const shouldAppendDefaultNewCards = flag && !multiTemplate;
  const needsNewCardInfo =
    flag && (usesNewCardPlaceholders || shouldAppendDefaultNewCards);

  const placeholders = {
    user: "viewer",
    card: input.drawnCards[0],
    rarity: "レア",
    cards: flag ? input.drawnCards.join(CARD_LIST_SEPARATOR) : undefined,
    draws: input.drawnCards.length,
    rarityCounts: input.rarityCounts,
    newCards:
      needsNewCardInfo && input.newCardNames.length > 0
        ? input.newCardNames.join(CARD_LIST_SEPARATOR)
        : undefined,
    newCardCount: needsNewCardInfo ? input.newCardNames.length : undefined,
    newCardsOrNone:
      needsNewCardInfo && input.newCardInfoResolved
        ? input.newCardNames.length > 0
          ? input.newCardNames.join(CARD_LIST_SEPARATOR)
          : "なし"
        : undefined,
    url: undefined,
    detail: undefined,
    num: undefined,
    unique: undefined,
    all: undefined,
    packName: undefined,
  };

  const willAppendDefaultNewCards =
    shouldAppendDefaultNewCards && input.newCardNames.length > 0;
  const reservedSuffixCharacters = willAppendDefaultNewCards
    ? countCharacters(" 初出: ") +
      countCharacters(input.newCardNames.join(CARD_LIST_SEPARATOR))
    : 0;

  let message: string;
  if (flag && usesMultiDrawPlaceholders) {
    const fitted = fitCardNamesForMessage(
      input.drawnCards,
      (cardsText) =>
        chat.buildMessage(messageTemplate, { ...placeholders, cards: cardsText }),
      reservedSuffixCharacters,
    );
    message = fitted.message;
  } else {
    const baseMessage = chat.buildMessage(messageTemplate, placeholders);
    message =
      flag && !usesMultiDrawPlaceholders
        ? fitCardNamesForMessage(
            input.drawnCards,
            (cardsText) =>
              `${baseMessage}（全${input.drawnCards.length}枚: ${cardsText}）`,
            reservedSuffixCharacters,
          ).message
        : baseMessage;
  }

  if (willAppendDefaultNewCards) {
    message = fitCardNamesForMessage(
      input.newCardNames,
      (newCardsText) => `${message} 初出: ${newCardsText}`,
    ).message;
  }
  return message;
}

// 新エンジン（placeholder 駆動）のメッセージ構築。フラグは読まず、
// 暗黙「（全N枚）」追記は廃止、初出接尾辞は「multi_template 未使用（NULL/''）」
// のときだけ発火する恒久セマンティクスとする。
function placeholderDrivenAnnounce(
  multiTemplate: string | null,
  input: DrawInput,
): string {
  const messageTemplate = multiTemplate || DEFAULT_MULTI_DRAW_CHAT_TEMPLATE;
  const usesMultiDrawPlaceholders = MULTI_DRAW_PLACEHOLDER_RE.test(messageTemplate);
  const usesNewCardPlaceholders = NEW_CARD_PLACEHOLDER_RE.test(messageTemplate);
  const shouldAppendDefaultNewCards = !multiTemplate;
  const needsNewCardInfo =
    usesNewCardPlaceholders || shouldAppendDefaultNewCards;

  const placeholders = {
    user: "viewer",
    card: input.drawnCards[0],
    rarity: "レア",
    cards: input.drawnCards.join(CARD_LIST_SEPARATOR),
    draws: input.drawnCards.length,
    rarityCounts: input.rarityCounts,
    newCards:
      needsNewCardInfo && input.newCardNames.length > 0
        ? input.newCardNames.join(CARD_LIST_SEPARATOR)
        : undefined,
    newCardCount: needsNewCardInfo ? input.newCardNames.length : undefined,
    newCardsOrNone:
      needsNewCardInfo && input.newCardInfoResolved
        ? input.newCardNames.length > 0
          ? input.newCardNames.join(CARD_LIST_SEPARATOR)
          : "なし"
        : undefined,
    url: undefined,
    detail: undefined,
    num: undefined,
    unique: undefined,
    all: undefined,
    packName: undefined,
  };

  const willAppendDefaultNewCards =
    shouldAppendDefaultNewCards && input.newCardNames.length > 0;
  const reservedSuffixCharacters = willAppendDefaultNewCards
    ? countCharacters(" 初出: ") +
      countCharacters(input.newCardNames.join(CARD_LIST_SEPARATOR))
    : 0;

  let message: string;
  if (usesMultiDrawPlaceholders) {
    const fitted = fitCardNamesForMessage(
      input.drawnCards,
      (cardsText) =>
        chat.buildMessage(messageTemplate, { ...placeholders, cards: cardsText }),
      reservedSuffixCharacters,
    );
    message = fitted.message;
  } else {
    // 暗黙の「（全N枚）」追記は廃止済み。
    message = chat.buildMessage(messageTemplate, placeholders);
  }

  if (willAppendDefaultNewCards) {
    message = fitCardNamesForMessage(
      input.newCardNames,
      (newCardsText) => `${message} 初出: ${newCardsText}`,
    ).message;
  }
  return message;
}

const BASE_INPUT: DrawInput = {
  drawnCards: ["カードA", "カードB", "カードC"],
  newCardNames: ["カードA"],
  newCardInfoResolved: true,
  rarityCounts: "レアx2、コモンx1",
};

const NO_NEW_INPUT: DrawInput = { ...BASE_INPUT, newCardNames: [] };

// 長いカード名で {cards} 圧縮が発生するケース（新旧とも同じ fit 経路を通ること）。
const LONG_INPUT: DrawInput = {
  drawnCards: Array.from(
    { length: 15 },
    (_, i) => `とてもながいながいカードめい${String(i).padStart(2, "0")}ばん`,
  ),
  newCardNames: ["とてもながいながいカードめい00ばん"],
  newCardInfoResolved: true,
  rarityCounts: "コモンx15",
};

type Combo = { flag: boolean; multiTemplate: string | null; label: string };

// issue「推奨移行方式」が要求する旧設定の全組み合わせ。
const COMBOS: Combo[] = [
  { flag: true, multiTemplate: null, label: "ON + DEFAULT（NULL）" },
  { flag: true, multiTemplate: "", label: "ON + DEFAULT（空文字）" },
  { flag: false, multiTemplate: null, label: "OFF + DEFAULT（NULL）" },
  { flag: false, multiTemplate: "", label: "OFF + DEFAULT（空文字）" },
  {
    flag: true,
    multiTemplate: "@{user} {draws}連: {cards} 初出{newCards}枚{newCardCount}種 {newCardsOrNone}",
    label: "ON + カード名系placeholder含有カスタム",
  },
  {
    flag: false,
    multiTemplate: "@{user} {draws}連: {cards} 初出{newCards}枚{newCardCount}種 {newCardsOrNone}",
    label: "OFF + カード名系placeholder含有カスタム",
  },
  {
    flag: true,
    multiTemplate: "@{user} {draws}連 {rarityCounts} ゲット！",
    label: "ON + 枚数系placeholderのみカスタム",
  },
  {
    flag: false,
    multiTemplate: "@{user} {draws}連 {rarityCounts} ゲット！",
    label: "OFF + 枚数系placeholderのみカスタム",
  },
  { flag: true, multiTemplate: "ガチャおめでとう！", label: "ON + placeholder無しカスタム" },
  { flag: false, multiTemplate: "ガチャおめでとう！", label: "OFF + placeholder無しカスタム" },
  {
    flag: false,
    multiTemplate: "{cards} {newCards}",
    label: "OFF + 除去後に空白のみになるカスタム",
  },
  {
    flag: false,
    multiTemplate: "初出: {newCards}",
    label: "OFF + 除去後にラベルが残るカスタム",
  },
];

describe("chat_announcement_multi_show_cards bake の新旧出力等価性 (Issue #1548)", () => {
  for (const { flag, multiTemplate, label } of COMBOS) {
    for (const [inputLabel, input] of [
      ["初入手あり", BASE_INPUT],
      ["初入手なし", NO_NEW_INPUT],
      ["長いカード名", LONG_INPUT],
    ] as const) {
      it(`${label} / ${inputLabel}: 旧エンジン出力と焼き込み後の新出力が一致する`, () => {
        const baked = bakeMultiShowCards(flag, multiTemplate);
        expect(placeholderDrivenAnnounce(baked, input)).toBe(
          legacyAnnounce(flag, multiTemplate, input),
        );
      });
    }
  }

  it("移行は冪等: 同じ行へ再適用しても変化しない", () => {
    for (const { flag, multiTemplate } of COMBOS) {
      const once = bakeMultiShowCards(flag, multiTemplate);
      // SQL は flag 列を更新しないため、再実行でも同じ flag 値で行を拾う。
      // OFF行は REPLACE の再適用が非含有テンプレートで no-op、ON行は追記後に
      // placeholder を含むため NOT LIKE 群で対象外、という収束を固定する。
      expect(bakeMultiShowCards(flag, once)).toBe(once);
    }
  });

  it("OFF + placeholder無しカスタムは flag を変えずとも新旧エンジンで等価", () => {
    // フラグを一括 true 化すると旧エンジンの暗黙追記が再発火して出力が変わる。
    // そのため migration は flag 列を一切更新しない設計であることを、
    // 「旧 flag=false のまま新旧エンジンで同出力」として固定する。
    const template = "ガチャおめでとう！";
    expect(placeholderDrivenAnnounce(template, BASE_INPUT)).toBe(
      legacyAnnounce(false, template, BASE_INPUT),
    );
    // 反対に flag を true にしてしまうと旧エンジンでは追記が発生し等価でない。
    expect(legacyAnnounce(true, template, BASE_INPUT)).not.toBe(
      legacyAnnounce(false, template, BASE_INPUT),
    );
  });
});
