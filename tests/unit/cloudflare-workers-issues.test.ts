import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const config = readFileSync(join(root, "wrangler.toml"), "utf8");
function section(name: string): string {
  const header = `[${name}]`;
  const start = config.indexOf(header);
  expect(start).toBeGreaterThanOrEqual(0);
  return config.slice(start + header.length).split(/^\[/m)[0];
}

describe("Workers Issues deployment contract", () => {
  it("preserves error monitoring across both regular deployment targets", () => {
    for (const scope of ["observability.issues", "env.preview.observability.issues"]) {
      expect(section(scope)).toMatch(/^enabled\s*=\s*true\s*$/m);
    }
  });
  it("pins a CLI and compatible types that understand the Issues configuration", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    expect(pkg.devDependencies.wrangler).toBe("4.134.0");
    expect(lock.packages["node_modules/wrangler"].version).toBe("4.134.0");
    expect(pkg.devDependencies["@cloudflare/workers-types"]).toBe("5.20260917.1");
    expect(lock.packages["node_modules/@cloudflare/workers-types"].version).toBe("5.20260917.1");
  });
  it("pins build/CI Node.js to a fully-specified 22.x patch at or above the security-fixed release", () => {
    // 2026-10-21 の Node.js security release では 22.23.4 が修正版（Refs #1914）。
    // `.node-version` をメジャー（"22"）だけにすると、actions/setup-node は runner の
    // ツールキャッシュにある旧パッチ（22.23.3）を選び、Workers Builds もビルド時点で自身が把握する
    // 22 系の最新（公開直後の修正版より古いことがある。2026-10-21 は 22.23.3）に解決するため、
    // 修正版が適用されない。そこでパッチまで完全固定（major.minor.patch）を要求する。
    // 下限（22.23.4 以上）を設けるのは、将来の巻き戻しや誤った downgrade で
    // 脆弱な版へ戻ることを防ぐため。比較は文字列ではなく数値で行う（22.23.10 > 22.23.4）。
    // trim 前の生の内容を検査する：Workers Builds は完全指定の版を trim せずインストーラへ渡すため、
    // 末尾改行付きの `22.23.4\n` ではインストールに失敗した（2026-10-21 build f2aaabd8 のログ。
    // Refs #1914）。actions/setup-node は値を trim するので CI だけでは検出できず、ここで固定する。
    const raw = readFileSync(join(root, ".node-version"), "utf8");
    expect(raw).toBe(raw.trim());
    const version = raw;
    expect(version).toMatch(/^22\.\d+\.\d+$/);
    const parse = (v: string) => v.split(".").map(Number);
    const atLeast = (actual: string, minimum: string) => {
      const a = parse(actual);
      const m = parse(minimum);
      for (let i = 0; i < m.length; i++) {
        if (a[i] !== m[i]) return a[i] > m[i];
      }
      return true;
    };
    expect(atLeast(version, "22.23.4")).toBe(true);

    // actions/setup-node を使う workflow は例外なく `.node-version` を参照し、
    // node-version の直書き（EOL の Node 20 など）を持たないこと。
    // 新しい workflow が追加されても漏れないよう、ファイル一覧は動的に取得する。
    const workflowDir = join(root, ".github/workflows");
    const workflows = readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f));
    expect(workflows.length).toBeGreaterThan(0);
    for (const workflow of workflows) {
      const text = readFileSync(join(workflowDir, workflow), "utf8");
      if (!text.includes("actions/setup-node")) continue;
      expect(text, `${workflow} must use node-version-file`).toContain("node-version-file: .node-version");
      expect(text, `${workflow} must not hardcode node-version`).not.toMatch(/^\s*node-version:/m);
    }
  });
  it("does not enable separately billed tracing or change the runtime date", () => {
    expect(config).not.toMatch(/^\[(?:env\.preview\.)?observability\.traces\]/m);
    expect(config).toMatch(/^compatibility_date\s*=\s*"2024-09-23"$/m);
  });
});
