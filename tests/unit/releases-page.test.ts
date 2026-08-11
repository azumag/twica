import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/app/releases/page.tsx"),
  "utf8",
);

describe("releases page", () => {
  it("places the August release ahead of the previous July release", () => {
    const august = source.indexOf("2026年8月アップデート");
    const july = source.indexOf("2026年7月アップデート");

    expect(august).toBeGreaterThanOrEqual(0);
    expect(july).toBeGreaterThan(august);
    expect(source).toContain("2026-08-12");
  });

  it("documents the main user-facing changes since the previous release", () => {
    // コミット名の羅列ではなく、利用者が確認・操作できる成果と恒久ページへの
    // 導線を固定する。内部CIだけの変更はリリースノート契約に含めない。
    expect(source).toContain('href="/live"');
    expect(source).toContain("ランキングは直近7日間と全期間を切り替えられます");
    expect(source).toContain("HEIC・HEIF画像");
    expect(source).toContain('href="/usages"');
    expect(source).toContain("配信者機能の利用対象を拡大");
    expect(source).toContain('href="/guide"');
    expect(source).toContain("メンテナンス中の引き換え保全");
    expect(source).toContain("Twitch連携の復旧案内");
    expect(source).toContain("セキュリティと長時間運用");
  });
});
