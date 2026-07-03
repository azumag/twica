-- Issue #393: Card pack ("collection") feature.
-- Let streamers split their cards into named packs and bind each channel-point
-- gacha reward (main reward + additional rewards) to a specific pack so that the
-- drawable cards change depending on which reward was redeemed.
--
-- Backward compatibility: a NULL collection_name means "all cards" (the existing
-- behavior), so existing cards/rewards keep working untouched after this migration.
--
-- 課題 #393: カードの「パック」(collection) 機能。
-- カードを名前付きパックに分け、チャネルポイント報酬(メイン報酬・追加報酬)
-- ごとに抽選対象パックを紐付けられるようにする。NULL は従来どおり「全カード」
-- を意味するため、既存データは無改変で動作を維持する。

-- 1. cards.collection_name: which pack a card belongs to (NULL = unclassified).
alter table public.cards
  add column if not exists collection_name text;

-- btrim を用いて空白のみ/空文字を弾く。API 側でも trim するが、DB 直書きや
-- 将来の import 経路に対する最終防衛線として DB 制約でも保証する。
-- Use btrim so whitespace-only/empty names are rejected at the DB level as a
-- last line of defense for direct writes / future import paths.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'cards_collection_name_length'
  ) then
    alter table public.cards
      add constraint cards_collection_name_length
      check (collection_name is null or char_length(btrim(collection_name)) between 1 and 80);
  end if;
end $$;

-- パック絞り込みクエリ (streamer_id + collection_name) 用の部分インデックス。
-- NULL (未分類) 行はインデックス対象外にして肥大化を防ぐ。
create index if not exists idx_cards_streamer_collection
  on public.cards (streamer_id, collection_name)
  where collection_name is not null;

-- 2. streamers.channel_point_collection_name: pack bound to the MAIN reward.
alter table public.streamers
  add column if not exists channel_point_collection_name text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'streamers_channel_point_collection_name_length'
  ) then
    alter table public.streamers
      add constraint streamers_channel_point_collection_name_length
      check (
        channel_point_collection_name is null
        or char_length(btrim(channel_point_collection_name)) between 1 and 80
      );
  end if;
end $$;

-- 3. streamer_additional_gacha_rewards.collection_name: pack bound to an
--    ADDITIONAL reward. NULL keeps the existing "all cards" behavior.
alter table public.streamer_additional_gacha_rewards
  add column if not exists collection_name text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'streamer_additional_rewards_collection_name_length'
  ) then
    alter table public.streamer_additional_gacha_rewards
      add constraint streamer_additional_rewards_collection_name_length
      check (collection_name is null or char_length(btrim(collection_name)) between 1 and 80);
  end if;
end $$;
