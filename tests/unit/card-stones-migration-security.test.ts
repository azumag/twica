import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("card stones migration security", () => {
  it("restricts card stone management policies to the service role", () => {
    const migration = readFileSync(
      resolve(__dirname, "../../supabase/migrations/00059_add_card_stones_exchange.sql"),
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

  it("hardens the idempotency migration (search_path, request_id, ON CONFLICT)", () => {
    const migration = readFileSync(
      resolve(
        __dirname,
        "../../supabase/migrations/00060_card_stone_exchange_idempotency.sql"
      ),
      "utf8"
    );

    // SECURITY DEFINER 関数の search_path を固定していること
    expect(migration).toMatch(
      /SECURITY DEFINER\s+SET search_path = public, pg_temp/
    );

    // request_id 列と (user_id, request_id) の一意制約があること
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS request_id UUID");
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX[\s\S]*card_stone_transactions\(user_id, request_id\)/
    );

    // 多重交換を防ぐ ON CONFLICT DO NOTHING があること
    expect(migration).toContain(
      "ON CONFLICT (user_id, request_id) DO NOTHING"
    );

    // p_request_id 引数を受け取る新シグネチャがあること
    expect(migration).toContain("p_request_id UUID");

    // 旧シグネチャ（冪等性キーなし）が削除されること
    expect(migration).toContain(
      "DROP FUNCTION IF EXISTS exchange_duplicate_card_for_stones(TEXT, UUID);"
    );
  });
});
