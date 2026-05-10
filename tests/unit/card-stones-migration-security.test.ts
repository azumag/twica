import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("card stones migration security", () => {
  it("restricts card stone management policies to the service role", () => {
    const migration = readFileSync(
      resolve(__dirname, "../../supabase/migrations/00040_add_card_stones_exchange.sql"),
      "utf8"
    );

    expect(migration).toContain(`CREATE POLICY "Service can manage card stone balances"
ON card_stone_balances
FOR ALL TO service_role
USING (true) WITH CHECK (true);`);

    expect(migration).toContain(`CREATE POLICY "Service can manage card stone transactions"
ON card_stone_transactions
FOR ALL TO service_role
USING (true) WITH CHECK (true);`);
  });
});
