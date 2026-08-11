import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "db/planetscale/migrations/20260811140000_publish_live_directory_announcement.sql",
  ),
  "utf8",
);

describe("live directory announcement migration", () => {
  it("publishes one idempotent informational announcement", () => {
    expect(migration).toMatch(
      /^-- migration-transaction: required\n-- migration-providers: planetscale/,
    );
    expect(migration).toContain("INSERT INTO public.announcements");
    expect(migration).toContain("'チャネル・ランキングページを公開しました'");
    expect(migration).toMatch(/'info',\s*true,/i);
    expect(migration).toContain("ON CONFLICT (id) DO NOTHING");
  });

  it("is visible immediately and expires exactly seven days after publication", () => {
    // published_atとexpires_atを同じDB基準時刻から計算し、アプリサーバーとの
    // clock skewやmigration実行時刻のハードコードを避ける。
    expect(migration).toMatch(
      /CURRENT_TIMESTAMP,\s*CURRENT_TIMESTAMP \+ INTERVAL '7 days'/i,
    );
  });

  it("links to the production live page without trailing punctuation", () => {
    expect(migration).toContain("\\nhttps://twica.bluemoon.works/live'");
  });
});
