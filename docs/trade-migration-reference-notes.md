# Card trading migration reference notes

`db/planetscale/migrations/20260817100000_add_card_trading.sql` is an applied migration candidate whose checksum is tracked by `db-migrate`. Do not edit that migration after it has been registered, including comment-only edits; changing any byte changes the checksum and can block `apply`, `status`, `plan`, and `verify`.

When documentation or review notes need to refer to logic inside `accept_trade_offer`, use stable SQL identifiers and processing stages rather than line numbers:

- **Payer candidate locking:** the `PERFORM` immediately before payer selection locks all eligible candidate `user_cards` rows in deterministic order. The following stage-2 `SELECT ... INTO v_payer_user_card_id ... LIMIT 1` intentionally does not add `FOR UPDATE`; the two-stage pattern avoids the `LIMIT 1 + FOR UPDATE` candidate-selection problem while preserving the lock order.
- **Offered-card ownership check:** the `SELECT ... INTO v_offered_card_owner_check ... FOR UPDATE` is the ownership/existence check for the offered card. Later logic may rely on that row already being locked.
- **Payer selection:** references to the chosen payment card should use `v_payer_user_card_id`, not migration line ranges.
- **Lock-order contract:** describe the invariant as `trade_offers row -> offered user_cards row -> payer candidate user_cards rows`, rather than pointing at specific line numbers.

This file is the safe place for maintenance-oriented annotations that would otherwise require comment-only edits to an already tracked migration.

Refs #1013, #1099
