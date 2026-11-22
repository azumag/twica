"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";

/**
 * トレード・オークション画面のカード表示名（#2070 フォローアップ / C4a）。
 *
 * 背景:
 * - C3a/C3b でトレード・オークションの DTO（TradeCardSnapshot / WantableCard）は、
 *   閲覧者に名前を見せてはいけないカードを `name: ""` で返すようになった。
 *   そのまま描画すると名前欄が空白になり、どのカードか分からなくなる。
 * - 代わりに DTO は `collectionNumber`（その配信者の百科事典番号 #N。
 *   閲覧者に依存しない）を持つ。カード定義が削除済み（card_id = NULL）で
 *   番号も証明できないときだけ null になる。
 *
 * このモジュールは「名前 → #N → 削除されたカード」の優先順位を1箇所に閉じ込め、
 * トレード UI の各所が独自に `name || ...` を書いて表記がばらつく（＝片方の画面
 * だけ名前が漏れる/空白になる）のを防ぐ。純関数 + その i18n 配線フックの2つだけを
 * 公開し、状態は持たない。
 *
 * セキュリティ上の注意:
 * - ここで扱うのは「表示文字列」だけ。非公開項目の実値はサーバー側（maskTradeCards /
 *   listWantableCards）で既に落ちている前提であり、この関数はマスクの代替ではない。
 * - 番号は閲覧者に依存しない値なので、名前が非公開でも #N を出してよい（要件）。
 */

/**
 * 表示名の材料。TradeCardSnapshot / WantableCard / TradeCardDisplay など、
 * トレード UI が受け取るカード型が構造的にそのまま渡せる形にしてある
 * （collectionNumber は OwnedCardGroup のように番号を持たない型もあるため任意）。
 */
export type TradeCardLabelSource = {
  /** 空文字は「名前が非公開（または不明）」。 */
  name: string;
  /** 閲覧者に依存しない百科事典番号。#N 表示に使う。null は削除済み・不明。 */
  collectionNumber?: number | null;
};

/** 表示名の組み立てに使う i18n テンプレート。 */
export type TradeCardLabelTemplates = {
  /**
   * 番号表記のテンプレート（例 "#{number}"）。
   * コレクション画面と同じ表記に揃える必要があるため、messages では
   * `trade.cardNumberLabel` に `collection.cardNumber` と同値を置いている。
   * trade のクライアント provider は collection namespace を積まない
   * （src/i18n/client-namespaces.ts）ので、キーを共有せず値だけ揃える。
   */
  cardNumberTemplate: string;
  /** 名前も番号も分からないカードの表示名（例 "削除されたカード"）。 */
  deletedLabel: string;
};

/**
 * messages のキー名。コンポーネント側で「表示名が削除フォールバックか」を
 * 判定する用途にも使うため、文字列の二重管理を避けて定数化する。
 */
export const TRADE_CARD_LABEL_MESSAGE_KEYS = {
  cardNumber: "cardNumberLabel",
  deletedName: "deletedCardName",
} as const;

/**
 * カード1枚の表示名を返す（純関数）。
 *
 * 優先順位:
 *   1. name が非空      → そのまま name（実名。前後空白のみの名前は「空」と同扱い）
 *   2. name が空 + #N   → 番号テンプレートで "#N"
 *   3. どちらも無い     → 削除されたカード（card_id = NULL / 番号不明）
 *
 * 2 で「番号がある」のは正の整数のみ。createCollectionNumberMap は 1 以上しか
 * 作らないため、0 や負値・小数が混ざった場合は番号を信用せず削除表示へ倒す
 * （fail-closed。存在しない番号を表示するとコレクション画面と食い違う）。
 *
 * レアリティはこの関数の対象外（従来どおり呼び出し側が別途表示する）。
 */
export function formatTradeCardLabel(
  card: TradeCardLabelSource,
  templates: TradeCardLabelTemplates,
): string {
  // 1. 実名が分かるならそれが最優先。trim() は判定だけに使い、戻り値は元の
  //    文字列のまま（意図的に含まれた前後空白を勝手に削らない）。
  if (card.name.trim() !== "") return card.name;

  // 2. 名前は非公開でも、閲覧者非依存の #N は出せる。テンプレートは
  //    コレクション画面（SortedCardGrid の cardNumberTemplate 置換）と同じ
  //    `replace("{number}", ...)` で組み立てる。
  const number = card.collectionNumber;
  if (typeof number === "number" && Number.isInteger(number) && number > 0) {
    return templates.cardNumberTemplate.replace("{number}", String(number));
  }

  // 3. 名前も番号も証明できない = カード定義が削除済み、またはスナップショットが
  //    壊れている。空白のまま出さず、明示的に「削除されたカード」と伝える。
  return templates.deletedLabel;
}

/**
 * クライアントコンポーネント向けの i18n 配線。
 *
 * 返り値はカードを受けて表示名を返す関数。`useCallback` でテンプレートが
 * 変わらない限り同一参照を返すので、依存配列に入れても再レンダーを誘発しない。
 * フックなので "use client" のコンポーネントからのみ呼ぶこと。
 */
export function useTradeCardLabel(): (card: TradeCardLabelSource) => string {
  const t = useTranslations("trade");
  const cardNumberTemplate = t(TRADE_CARD_LABEL_MESSAGE_KEYS.cardNumber);
  const deletedLabel = t(TRADE_CARD_LABEL_MESSAGE_KEYS.deletedName);
  return useCallback(
    (card: TradeCardLabelSource) =>
      formatTradeCardLabel(card, { cardNumberTemplate, deletedLabel }),
    [cardNumberTemplate, deletedLabel],
  );
}
