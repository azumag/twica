-- migration-transaction: required
-- migration-providers: planetscale

-- Issue #1548: N連チャット通知をプレースホルダー駆動へ一本化するための互換移行 (bake)。
-- `chat_announcement_multi_show_cards` の現在値と保存済みテンプレートが旧仕様で生む
-- 実効チャット文面を、フラグ非依存のテンプレート内容だけで再現できるよう一度だけ変換する。
--
-- 旧仕様におけるフラグの意味（eventsub-redemption.ts のゲート）:
--   1. {cards} / {newCards} / {newCardCount} / {newCardsOrNone} の値が空文字になる
--      （初入手情報を取得するクエリ自体も発行しない）
--   2. テンプレートに multi-draw 用 placeholder が1つも無いとき、末尾へ
--      「（全N枚: {cards}）」を暗黙追記する
--   3. multi_template が NULL（= DEFAULT テンプレート使用）のとき、
--      「 初出: {newCardNames}」を条件付きで接尾する
--   ※ {draws} / {rarityCounts} はフラグ非依存で常に解決される。
--
-- 移行の設計:
--   - フラグ列自体は書き換えない。焼き込み後のテンプレートは、旧エンジン（フラグ読む）でも
--     新エンジン（フラグ無視）でも同じ実効出力を出すため、デプロイ順序に依存しない
--     （OFF + placeholder無しカスタム行で flag を true にすると旧エンジンが追記を再開する
--     ため、フラグを一括 true 化してはならない）。
--   - 冪等: OFF 行は焼き込み後も対象外判定が変わらず、ON 行は追記後に placeholder を
--     含むため NOT LIKE 群で除外され、再実行で二重追記しない。
--
-- CASE 1: flag OFF の行（旧仕様ではカード名系が全て空文字・追記も無し）
UPDATE public.streamers
SET chat_announcement_multi_template = CASE
    -- OFF + DEFAULT 使用（NULL または空文字。`||` フォールバックで同じ扱い）:
    -- 旧出力 = DEFAULT の {cards} が空・初出接尾辞なし、と等価な
    -- 「DEFAULT から {cards} を除いた明示テンプレート」へ焼き込む。
    WHEN chat_announcement_multi_template IS NULL
      OR chat_announcement_multi_template = ''
      THEN '@{user} が{draws}連ガチャで {rarityCounts} を獲得しました！'
    -- OFF + カスタムテンプレート: カード名系 placeholder 4種だけを除去
    -- （{draws} / {rarityCounts} はフラグ非依存で旧仕様でも解決されていたため残す）。
    -- {newCards} は {newCardsOrNone} の部分文字列ではないため REPLACE 順序は問わない。
    ELSE CASE
      -- 除去後が空白のみになるテンプレート（例 '{cards} {newCards}'）は、
      -- 空文字だと `||` フォールバックで DEFAULT へ縮退し出力が変わるため、
      -- JS 側の trim で空出力を維持する半角空白1文字を書く。
      WHEN btrim(REPLACE(REPLACE(REPLACE(REPLACE(
             chat_announcement_multi_template,
             '{cards}', ''),
             '{newCardsOrNone}', ''),
             '{newCardCount}', ''),
             '{newCards}', '')) = ''
        THEN ' '
      ELSE REPLACE(REPLACE(REPLACE(REPLACE(
             chat_announcement_multi_template,
             '{cards}', ''),
             '{newCardsOrNone}', ''),
             '{newCardCount}', ''),
             '{newCards}', '')
    END
  END
WHERE chat_announcement_multi_show_cards = false;

-- CASE 2: flag ON + カスタムテンプレートに multi-draw 用 placeholder が1つも無い行
-- （旧仕様では末尾に「（全N枚: {cards}）」が暗黙追記されていた）。
-- 暗黙追記を廃止する新仕様でも同じ出力になるよう、等価の
-- 「（全{draws}枚: {cards}）」を明示的に焼き込む。
-- `{draws}` は旧実装の `drawnCards.length` 直値と同じ値に解決される。
-- 空文字テンプレートは `||` で DEFAULT 扱いのため対象外（NULL 同様に何もしない）。
UPDATE public.streamers
SET chat_announcement_multi_template =
      chat_announcement_multi_template || '（全{draws}枚: {cards}）'
WHERE chat_announcement_multi_show_cards = true
  AND chat_announcement_multi_template IS NOT NULL
  AND chat_announcement_multi_template <> ''
  AND chat_announcement_multi_template NOT LIKE '%{cards}%'
  AND chat_announcement_multi_template NOT LIKE '%{draws}%'
  AND chat_announcement_multi_template NOT LIKE '%{rarityCounts}%'
  AND chat_announcement_multi_template NOT LIKE '%{newCards}%'
  AND chat_announcement_multi_template NOT LIKE '%{newCardCount}%'
  AND chat_announcement_multi_template NOT LIKE '%{newCardsOrNone}%';

-- CASE 3（書き込みなし・対象外の確認用）:
--   - flag ON + DEFAULT 使用: DEFAULT が {cards} を含み、初出接尾辞は
--     「multi_template が NULL のとき」という新ルールでも維持されるため変更不要。
--   - flag ON + placeholder 含有カスタム: 既に placeholder 駆動と同じ解決のため変更不要。
