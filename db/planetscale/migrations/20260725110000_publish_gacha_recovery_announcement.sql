-- migration-transaction: required
-- migration-providers: planetscale
--
-- ガチャ結果オーバーレイ表示・Twitchチャット通知の復旧告知を公開するデータ migration。
-- 障害の開始時刻は観測時刻と一致する保証がないため本文へ含めず、確認済みの復旧内容だけを
-- 利用者へ伝える。schema変更ではないので、既存のannouncementsテーブルを1行だけ追加する。
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
  'a8030000-0000-4000-8000-000000000001'::uuid,
  'ガチャ結果表示・チャット通知障害の復旧について',
  '一部のチャネルポイント引き換えで、2回目以降のガチャ結果がオーバーレイに表示されない、またはチャット通知が送信されない事象が発生していました。現在は復旧し、実際のチャネルポイント引き換えで連続表示とチャット通知を確認しています。ご不便をおかけし、申し訳ありませんでした。',
  'warning',
  true,
  now(),
  NULL
)
ON CONFLICT (id) DO NOTHING;
