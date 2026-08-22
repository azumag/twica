# Card trading migration reference notes

`db/planetscale/migrations/20260817100000_add_card_trading.sql` is an applied
migration candidate whose checksum is tracked by `db-migrate`. Do not edit that
migration after it has been registered, including comment-only edits; changing
any byte changes the checksum and can block `apply`, `status`, `plan`, and
`verify`.

When documentation or review notes need to refer to logic inside
`accept_trade_offer`, use stable SQL identifiers and processing stages rather
than line numbers. Use **payer selection** for the overall two-step operation;
avoid positional labels such as **stage 2**, which can become ambiguous as the
migration evolves:

- **Payer selection — candidate locking:** the `PERFORM` first locks all
  eligible candidate `user_cards` rows in deterministic order. This
  full-candidate locking step is the first half of the payer-selection
  contract.
- **Payer selection — candidate choice:** the following
  `SELECT ... INTO v_payer_user_card_id ... LIMIT 1` intentionally does not add
  `FOR UPDATE`. Safety comes from the preceding full-candidate lock plus this
  lock-free choice; describe the two statements together as **payer
  selection**, and the individual steps as **candidate locking** and
  **candidate choice**.
- **Offered-card existence/ownership check:** the
  `SELECT ... INTO v_offered_card_owner_check ... FOR UPDATE` verifies that the
  offered card exists and is still owned by the offerer, while locking that row
  for the later transfer. Prefer this role-based name in prose; use
  `v_offered_card_owner_check` when the exact result variable matters.
- **Chosen payment card:** references to the selected payment card should use
  `v_payer_user_card_id`, not migration line ranges.
- **Lock-order contract:** describe the invariant as
  `trade_offers row -> offered user_cards row -> payer candidate user_cards rows`,
  rather than pointing at specific line numbers.

This file is the safe place for maintenance-oriented annotations that would
otherwise require comment-only edits to an already tracked migration.

Refs #1013, #1099, #1100
