-- migration-transaction: required
-- migration-providers: planetscale
--
-- #740: チャネル・ランキングページ公開をダッシュボード利用者へ知らせる。
-- schema変更ではなく、既存announcementsテーブルへ公開告知を1行だけ追加する。
--
-- 固定UUIDをidempotency keyにし、migration再実行や環境復元後の再適用でも重複を
-- 作らない。公開・期限の基準には同一transaction内のDB時刻を使い、適用から正確に
-- 7日間だけ未読バナーの対象にする。本文URLはAutoLinkTextが日本語句読点までURLへ
-- 含めないよう末尾の独立行へ置く。
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
  'a8110000-0000-4000-8000-000000000001'::uuid,
  'チャネル・ランキングページを公開しました',
  E'TwiCaを利用中のチャネルと、カード引き換え数・チャネルポイント・カード種類数のランキングを確認できるページを公開しました。ランキングは直近7日間と全期間を切り替えられます。掲載設定とランキング上のチャネル表示は、ダッシュボードの配信設定から変更できます。\nhttps://twica.bluemoon.works/live',
  'info',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP + INTERVAL '7 days'
)
ON CONFLICT (id) DO NOTHING;
