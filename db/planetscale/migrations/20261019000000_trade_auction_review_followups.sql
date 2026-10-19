-- migration-transaction: required
-- migration-providers: planetscale

-- Issue #1851: PR #1850 独立レビューの任意指摘の後続対応。
--   1. idx_trade_auctions_seller_user_id は idx_trade_auctions_seller_request
--      (seller_user_id, request_id) の先頭列でカバーされるため削除する。
--   2. 'expired' は書き込み経路のない予約値なので許可しない。流札は 'open' のまま
--      時刻を過ぎた行を trade_auction_holds_cards() で導出する。
SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS public.idx_trade_auctions_seller_user_id;

UPDATE public.trade_auctions SET status = 'open' WHERE status = 'expired';

ALTER TABLE public.trade_auctions DROP CONSTRAINT IF EXISTS trade_auctions_status_check;
ALTER TABLE public.trade_auctions
  ADD CONSTRAINT trade_auctions_status_check
  CHECK (status IN ('open', 'completed', 'cancelled'));
