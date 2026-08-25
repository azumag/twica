import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(repoRoot, "scripts/compare-analysis-dashboard-vs-sql.mjs");

describe("compare-analysis-dashboard-vs-sql CLI", () => {
  it("DASHBOARD_DATABASE_URL が未設定なら DB へ接続せず終了コード2を返す", () => {
    const env = {
      ...process.env,
      // 旧接続変数が存在しても DASHBOARD_DATABASE_URL へフォールバックしないことを
      // CLI 経路でも固定する。
      DATABASE_URL_PLANETSCALE: "postgres://must-not-be-used",
      PLANETSCALE_DATABASE_URL: "postgres://must-not-be-used",
    };
    delete env.DASHBOARD_DATABASE_URL;

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("DASHBOARD_DATABASE_URL の設定が必要です。");
  });
});
