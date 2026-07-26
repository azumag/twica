-- migration-transaction: required
-- migration-providers: planetscale
--
-- issue #788（PR #795 → #796 でmainへ昇格、本番適用済み）のリリースノートを
-- お知らせとして公開するデータ migration。schema変更は伴わず、
-- announcements テーブルへ1行だけ追加する。
--
-- 公開して良いと判断した根拠（本番PlanetScale prod で確認済み）:
--   - 機能の前提となる migration 20260723150000（users.channel_points_capability /
--     _checked_at / channel_points_enabled と有効化RPC）が
--     twica_meta.schema_migrations に適用済みとして記録されている。
--     つまり告知を読んだ配信者がその場で有効化操作を実行できる状態にある。
--
-- 本文は視聴者ではなく配信者向けの操作案内なので、UI上の実際の文言
-- （messages/ja.json の channelPointsAccess.*）と表記を一致させ、
-- 告知を読んでそのまま操作できるようにする。
-- 判定が読み取り専用のTwitch API呼び出しであること、本人が有効化を押すまで
-- 配信者機能は有効にならないことを明記し、勝手に権限が変わるという誤解を防ぐ。
-- body は AutoLinkText + whitespace-pre-wrap で描画されるため、改行はそのまま
-- 反映され、URLは自動でリンク化される（Markdownは解釈されないので記号装飾はしない）。
--
-- 障害告知ではなく機能リリースの案内なので severity は 'info'
-- （直前の 20260725110000 は障害復旧のため 'warning'）。
--
-- 固定UUIDをidempotency keyにする。migrationの再実行、または環境復元後の再適用でも
-- 同じ告知が重複表示されないよう、主キー競合時は既存行を更新せずDO NOTHINGにする。
-- published_atは適用時のDB時刻を正本とし、expires_atはNULLのまま履歴・未読表示へ残す。
INSERT INTO public.announcements (
  id,
  title,
  body,
  severity,
  is_published,
  published_at,
  expires_at
)
VALUES (
  'a7880000-0000-4000-8000-000000000001'::uuid,
  '配信者機能をアフィリエイト／パートナー以外の配信者にも開放しました',
  'Twitchの「Monetization for All」が2026年5月13日に世界展開され、収益化オンボーディングを完了していれば、アフィリエイト／パートナーでなくてもチャネルポイントを利用できるようになりました。これに合わせて、twicaの配信者機能もアフィリエイト／パートナー限定ではなくなりました。

【使いはじめかた】
1. ユーザー設定を開き、「チャネルポイント / 配信者機能」の欄を確認する
2. 「Twitchと再連携して確認」が表示されている場合は押して、チャネルポイントの利用可否を判定する
3. 利用できることを確認できたら「twicaで配信者機能を有効にする」を押す

有効化すると、カード管理・オーバーレイ・チャネルポイント引き換えの設定が利用できるようになります。

【補足】
・すでにアフィリエイト／パートナーの配信者は、これまでどおりご利用いただけます。操作は必要ありません。
・利用可否の判定は読み取り専用のTwitch API呼び出しのみで行います。配信者ご自身が有効化を押すまで、twicaの配信者機能は有効になりません。
・「現在Twitch上でチャネルポイントを利用できません」と表示される場合は、Twitch Creator Dashboardで収益化オンボーディングとチャネルポイントの設定をご確認のうえ、「再判定」をお試しください。
・参考: https://blog.twitch.tv/en/2026/05/13/monetization-for-all/',
  'info',
  true,
  now(),
  NULL
)
ON CONFLICT (id) DO NOTHING;
