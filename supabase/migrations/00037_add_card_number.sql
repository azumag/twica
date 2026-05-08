-- Allow streamers to pin encyclopedia card numbers manually.
-- Unset cards keep using the application fallback numbering.
alter table public.cards
  add column if not exists card_number integer;

alter table public.cards
  add constraint cards_card_number_positive
  check (card_number is null or card_number > 0);

create unique index if not exists cards_streamer_card_number_unique
  on public.cards (streamer_id, card_number)
  where card_number is not null;
