/**
 * 未所持カードの項目別公開設定（Issue #2070 フォローアップ / PR2）。
 *
 * 背景:
 * - streamers.show_unowned_cards は「未所持カードをコレクションに表示するか」の
 *   マスタースイッチ。false なら未所持カード自体を出さない。
 * - 旧 streamers.show_unowned_card_details は「未所持カードの名前・画像・説明を
 *   まとめて公開するか」の単一フラグ。旧アプリ・旧画面との互換のため残している。
 * - 新しく show_unowned_card_name / show_unowned_card_image /
 *   show_unowned_card_description の3列が追加され、項目ごとに公開を切り替えられる。
 *   新アプリは3列の AND を旧 show_unowned_card_details へミラー書込みする（C4）。
 *
 * このモジュールは DB に依存しない純関数だけを置く。コレクション画面（RSC）と
 * クライアントコンポーネントの両方から同じ規則を参照でき、規則の二重実装による
 * 公開・非公開の食い違いを防ぐのが目的。
 *
 * 最重要の原則:
 * 「非公開項目の実値（名前・画像URL・説明）を RSC ペイロード / API レスポンスへ
 *   載せない」。判定結果（boolean）だけをクライアントへ渡し、実値のマスクは
 *   サーバー側（RSC）で行う。クライアント側のマスクは表示上の保険であり、
 *   ペイロード防御の代わりにはならない。
 */

import type { AnyColumn } from "drizzle-orm";
import { sql, type SQL } from "drizzle-orm/sql";

/**
 * resolveUnownedCardVisibility の入力。
 *
 * streamers 行そのものではなく「必要な列だけ」を受け取る。呼び出し側は
 * `Streamer` 型の行をそのまま渡せる（構造的部分型）。
 *
 * 新3列を optional / null 許容にしているのは、デプロイ窓（migration 未適用の間に
 * アプリだけが先にデプロイされた状態）では STREAMERS_SAFE_COLUMNS へ縮退した
 * 再試行側の行に新3列が存在せず、実行時に undefined になるため。型を必須の
 * boolean にすると「取れなかったこと」を表現できず、誤って false 扱いで
 * 個別判定に流れてしまう。
 */
export interface UnownedCardVisibilityRow {
  /** 未所持カードを表示するかのマスタースイッチ。 */
  show_unowned_cards: boolean | null | undefined;
  /** 旧「詳細公開」フラグ。互換のために残っている。 */
  show_unowned_card_details?: boolean | null;
  /** 未所持カードの名前を公開するか（新列）。 */
  show_unowned_card_name?: boolean | null;
  /** 未所持カードの画像を公開するか（新列）。 */
  show_unowned_card_image?: boolean | null;
  /** 未所持カードの説明を公開するか（新列）。 */
  show_unowned_card_description?: boolean | null;
}

/** 項目別の公開可否。true の項目だけ実値を表示・送信してよい。 */
export interface UnownedCardItemVisibility {
  name: boolean;
  image: boolean;
  description: boolean;
}

/**
 * 全項目非公開の既定値。React コンポーネントの props 既定値として使う。
 * 呼び出し側が公開設定を渡し忘れた場合は「何も出さない」に倒す（fail-closed）。
 */
export const HIDDEN_UNOWNED_CARD_ITEM_VISIBILITY: Readonly<UnownedCardItemVisibility> =
  Object.freeze({ name: false, image: false, description: false });

function hiddenVisibility(): UnownedCardItemVisibility {
  // 呼び出し側が返り値を書き換えても共有定数へ影響しないよう、毎回新しい
  // オブジェクトを返す（純関数としての契約を保つ）。
  return { name: false, image: false, description: false };
}

/**
 * streamers 行の公開設定から、未所持カードの項目別公開可否を解決する。
 *
 * 規則（この順で評価する。順序自体が意味を持つ）:
 *
 * a. show_unowned_cards が true でなければ全項目 false。
 *    マスタースイッチは「未所持カードをそもそも見せるか」を決める最上位の設定で、
 *    項目別フラグより常に優先する。false の配信者のカードは、項目別フラグが
 *    過去の設定や手動更新で true のまま残っていても一切公開してはならない。
 *
 * b. 新3列のどれかが undefined / null なら、旧 show_unowned_card_details から導出する
 *    （true → 3項目すべて true / それ以外 → 3項目すべて false）。
 *    これはデプロイ窓（migration 未適用で STREAMERS_SAFE_COLUMNS へ縮退した行）の
 *    ための互換経路。新3列は1つの migration で同時に追加されるため通常は3列そろって
 *    欠落するが、部分的に欠けた状態を個別に採用すると、配信者が設定していない項目を
 *    公開してしまうおそれがある。そのため「1列でも取れなければ3列まとめて旧設定へ
 *    フォールバック」という all-or-nothing にし、旧設定が true のときだけ従来どおり
 *    全項目を公開する。旧設定も取れない/未設定なら全項目 false（fail-closed）。
 *
 * c. 旧アプリの OFF 取りこぼしガード:
 *    show_unowned_card_details が「明示的に false」かつ新3列が「すべて true」なら
 *    全項目 false として扱う。
 *    新アプリは details = name && image && description をミラー書込みするため、
 *    この組み合わせ（details=false なのに新3列が全部 true）は、新アプリ経由では
 *    決して生じない。生じ得るのは「旧アプリで詳細公開を OFF にした」場合だけである
 *    （旧アプリは新3列を更新しないため、以前 true だった3列が残る）。配信者が旧画面で
 *    明示的に切った設定を、新アプリが復活させてはならないので非公開へ倒す。
 *    なお部分公開（1〜2項目だけ true）は、ミラーにより details=false になる正当な
 *    状態なので、このガードの対象外（全 true のときだけ発動する）。
 *
 * d. それ以外は新3列の値をそのまま採用する。
 *    null や非 boolean が混入した場合は `=== true` で false に倒す（fail-closed）。
 */
export function resolveUnownedCardVisibility(
  row: UnownedCardVisibilityRow,
): UnownedCardItemVisibility {
  // 規則 a: マスタースイッチが明示的に true のときだけ先へ進む。
  if (row.show_unowned_cards !== true) {
    return hiddenVisibility();
  }

  const name = row.show_unowned_card_name;
  const image = row.show_unowned_card_image;
  const description = row.show_unowned_card_description;

  // 規則 b: 新3列がそろって取得できているかを確認する。null と undefined の
  // どちらも「このリクエストでは値が取れなかった」を意味するため同じ扱いにする。
  const hasAllItemFlags =
    name !== undefined && name !== null &&
    image !== undefined && image !== null &&
    description !== undefined && description !== null;

  if (!hasAllItemFlags) {
    // 旧設定が明示的に true のときだけ全項目公開。旧設定が false / null /
    // undefined の場合は全項目非公開へ倒す（fail-closed）。
    const legacyDetailsVisible = row.show_unowned_card_details === true;
    return {
      name: legacyDetailsVisible,
      image: legacyDetailsVisible,
      description: legacyDetailsVisible,
    };
  }

  // ここから先は新3列が boolean としてそろっている。
  const itemVisibility: UnownedCardItemVisibility = {
    name: name === true,
    image: image === true,
    description: description === true,
  };

  // 規則 c: 旧アプリで詳細公開を OFF にした取りこぼしを尊重する。
  // 「全 true のときだけ」に限定する理由は、部分公開はミラーで details=false に
  // なる正当な状態だから。ここで部分公開まで潰すと、新アプリで設定した
  // 「名前だけ公開」等が旧列の false に巻き戻されてしまう。
  if (
    row.show_unowned_card_details === false &&
    itemVisibility.name &&
    itemVisibility.image &&
    itemVisibility.description
  ) {
    return hiddenVisibility();
  }

  // 規則 d: 新3列をそのまま採用する。
  return itemVisibility;
}

/**
 * 旧 show_unowned_card_details へミラー書込みする値を計算する（C4 の設定 API が使用）。
 *
 * 「詳細公開」= 名前・画像・説明の3項目すべて公開、という旧アプリの意味論に合わせて
 * 3つの AND を返す。部分公開のときは false になり、旧アプリ側では詳細非公開として
 * 扱われる（新アプリの項目別表示は新3列を読むため影響を受けない）。
 *
 * 注意: この関数は「これから保存する値」を計算するだけで、resolve の規則 c が扱う
 * 「旧アプリが details だけを false にした」過去の状態は再現できない。そのため
 * resolve 側のガードが必要になる。
 */
export function mirrorUnownedCardDetails(
  visibility: UnownedCardItemVisibility,
): boolean {
  return visibility.name && visibility.image && visibility.description;
}

/**
 * 3項目すべてが公開されているか。
 *
 * 完了報酬（PackCompletionRewards）のように「未所持カードの詳細をまとめて見せる」
 * 既存 UI の条件として使う。項目別公開が導入されても、部分公開のカードを
 * 報酬一覧へ出すと「説明だけ非公開のはずが報酬カードとして実値が載る」といった
 * 抜けが生まれるため、既存挙動を保つ保守的な条件（全項目公開）に限定する。
 */
export function allUnownedCardItemsVisible(
  visibility: UnownedCardItemVisibility,
): boolean {
  return visibility.name && visibility.image && visibility.description;
}

// -----------------------------------------------------------------------------
// SQL 版の解決規則（トレード API 用）
//
// なぜ SQL に同じ規則を持つのか:
// - トレードの一覧・作成・応諾は「閲覧者が見てよい行/名前/画像か」を SQL の
//   WHERE / JOIN 条件で先に絞る（ページングや hasMore の件数から隠しカードの
//   存在が漏れないようにするため）。RSC のように行を取得してから TS で判定する
//   方式だと、行数や LIMIT の結果自体が side channel になる。
// - そのため resolveUnownedCardVisibility() と同じ規則を SQL でも表現する必要が
//   ある。2箇所に規則が分かれるため、**この2つは常に同値でなければならない**。
//   変更するときは tests/unit/unowned-card-visibility-sql.test.ts の
//   TS/SQL 同値テストと、tests/integration/trade-visibility-pg.test.ts の
//   実 PostgreSQL テストを必ず更新すること。
//
// 規則との対応:
//   a. show_unowned_cards = TRUE を外側の条件にする（マスタースイッチ）。
//   b. 新3列が取得できないデプロイ窓では withoutItemColumns = true で呼び、
//      旧 show_unowned_card_details だけから導出する（true → 公開 /
//      それ以外 → 非公開）。これは resolve の「3列のどれかが取れなければ
//      旧設定へ all-or-nothing でフォールバック」と同じ意味。SQL では
//      「列が存在しない」を値では表現できないので、42703 を検知した
//      呼び出し側（withUnownedCardItemColumnFallback）がこのフラグを立てる。
//   c. details = FALSE かつ新3列がすべて TRUE のときは全項目非公開。
//      旧アプリで詳細公開を OFF にした取りこぼしガード。部分公開は
//      ミラー書込みで details = FALSE になる正当な状態なので、
//      「3列すべて TRUE」のときにだけ発動させる（resolve と同じ）。
//   d. それ以外は対象項目の列が TRUE のときだけ公開。
//
// NULL の扱い: 新3列は migration で NOT NULL DEFAULT false。万一 NULL が
// 混入しても `= TRUE` は NULL（≠TRUE）になるため fail-closed（非公開）になる。
// resolve の `=== true` と同じ方向へ倒れる。
// -----------------------------------------------------------------------------

/** 未所持カードの公開対象項目。 */
export type UnownedCardVisibilityItem = "name" | "image" | "description";

/**
 * unownedCardItemVisibleSql() が参照する streamers の列。
 *
 * テーブルそのものではなく列だけを受け取るのは、呼び出し側が相関サブクエリの
 * 別名（visible_streamer / image_streamer など）を渡せるようにするため。
 * drizzle の `${column}` は WHERE 句では `"別名"."列"` に展開されるので、
 * 外側の streamers 行を安全に参照できる。
 */
export interface UnownedCardVisibilityColumns {
  show_unowned_cards: AnyColumn;
  /** 旧「詳細公開」列。STREAMERS_SAFE_COLUMNS にも含まれるため常に取得できる。 */
  show_unowned_card_details: AnyColumn;
  show_unowned_card_name: AnyColumn;
  show_unowned_card_image: AnyColumn;
  show_unowned_card_description: AnyColumn;
}

/**
 * resolveUnownedCardVisibility() の item 判定を SQL の boolean 式にする。
 *
 * 返り値は「その streamer の未所持カードについて、item を公開してよいか」だけを
 * 表す。所持している場合の判定（所持 ≥ 1 なら常に公開）は呼び出し側が
 * OR で足す。これは resolve が「未所持カードの公開設定」だけを扱い、所持の
 * 可否を知らないのと同じ責務分担である。
 *
 * @param streamer 相関サブクエリ内の streamers 別名の列一式。
 * @param item 判定する項目。
 * @param options.withoutItemColumns デプロイ窓（新3列が 42703 で欠落）用。
 *   true のときは旧 show_unowned_card_details だけを参照する。
 */
export function unownedCardItemVisibleSql(
  streamer: UnownedCardVisibilityColumns,
  item: UnownedCardVisibilityItem,
  options: { withoutItemColumns?: boolean } = {},
): SQL {
  // 規則 b: 新3列が無いデプロイ窓では旧設定だけを見る。
  if (options.withoutItemColumns === true) {
    return sql<boolean>`(
      ${streamer.show_unowned_cards} = TRUE
      AND ${streamer.show_unowned_card_details} = TRUE
    )`;
  }

  const itemColumn =
    item === "name"
      ? streamer.show_unowned_card_name
      : item === "image"
        ? streamer.show_unowned_card_image
        : streamer.show_unowned_card_description;

  // 規則 a（マスタースイッチ）→ d（項目列）→ c（旧アプリ OFF ガード）の順。
  // ガード c を最後に NOT で打ち消すのは、「3列すべて TRUE」の組み合わせだけを
  // 非公開へ倒すため。部分公開では NOT(...) が TRUE になり、項目列の値が
  // そのまま採用される（resolve の規則 d と同じ）。
  return sql<boolean>`(
    ${streamer.show_unowned_cards} = TRUE
    AND ${itemColumn} = TRUE
    AND NOT (
      ${streamer.show_unowned_card_details} = FALSE
      AND ${streamer.show_unowned_card_name} = TRUE
      AND ${streamer.show_unowned_card_image} = TRUE
      AND ${streamer.show_unowned_card_description} = TRUE
    )
  )`;
}
