import { existsSync, readdirSync, readFileSync } from "node:fs";
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
  it("pins build/CI Node.js to one fully-specified 22.x patch >= 22.23.4", () => {
    // 2026-10-21 の Node.js security release では 22.23.4 が修正版（CVE-2026-106069 の
    // TLS hostname bypass など High 複数を含む。Refs #1914）。ビルド・CI・migration
    // runner の Node 指定は `.node-version` 1 ファイルに正本化している（#1919 で
    // 追跡していた CI 用ピンとの一本化）。
    //
    // 完全指定（major.minor.patch）でなければならない理由:
    // - メジャー（"22"）だけだと actions/setup-node は runner のツールキャッシュにある
    //   旧パッチ（22.23.3）を選び、Cloudflare Workers Builds も自身の把握する 22 系最新
    //   （2026-10-21 時点は 22.23.3）に解決する。いずれも修正版未満のため脆弱性が残る。
    // - 2026-10-21 は完全指定 22.23.4 で Workers Builds のインストールが失敗したため
    //   （build f2aaabd8 / 2a8c9d68 / 6a27ed21）、一時的に CI 用ピンを
    //   `.github/ci-node-version` へ分離していた。#1914 の完了条件は Workers Builds でも
    //   修正版を使うことなので、分離を解消して単一ピンへ戻した。このファイル自体が
    //   setup-node / Workers Builds に版として読まれるため、コメント行は入れられない。
    //
    // 下限（22.23.4 以上）を設けるのは、将来の巻き戻しや誤った downgrade で脆弱な版へ
    // 戻ることを防ぐため。比較は文字列ではなく数値で行う（22.23.10 > 22.23.4）。
    const nodeVersion = readFileSync(join(root, ".node-version"), "utf8").trim();
    expect(nodeVersion).toMatch(/^22\.\d+\.\d+$/);
    const parse = (v: string) => v.split(".").map(Number);
    const atLeast = (actual: string, minimum: string) => {
      const a = parse(actual);
      const m = parse(minimum);
      for (let i = 0; i < m.length; i++) {
        if (a[i] !== m[i]) return a[i] > m[i];
      }
      return true;
    };
    expect(atLeast(nodeVersion, "22.23.4")).toBe(true);

    // 一時的な CI 用ピン（`.github/ci-node-version`）は廃止済み。残ったまま act して
    // いないと「どちらが正本か」が再び不明になるため、存在しないことを固定する。
    // Workers Builds が再び完全指定に対応できなくなった場合は、このテスト・docs・
    // workflow filter を同時に戻す形で分離を再導入する（手順は docs/cloudflare-workers-builds.md）。
    expect(existsSync(join(root, ".github/ci-node-version"))).toBe(false);

    // actions/setup-node を使う workflow は例外なく `.node-version` を参照し、
    // node-version の直書き（EOL の Node 20 など）を持たないこと。
    // 新しい workflow が追加されても漏れないよう、ファイル一覧は動的に取得する。
    const workflowDir = join(root, ".github/workflows");
    const workflows = readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f));
    expect(workflows.length).toBeGreaterThan(0);
    for (const workflow of workflows) {
      const text = readFileSync(join(workflowDir, workflow), "utf8");
      if (!text.includes("actions/setup-node")) continue;
      expect(text, `${workflow} must use node-version-file`).toContain(
        "node-version-file: .node-version",
      );
      expect(text, `${workflow} must not hardcode node-version`).not.toMatch(/^\s*node-version:/m);
    }
  });
  it("does not enable separately billed tracing or change the runtime date", () => {
    expect(config).not.toMatch(/^\[(?:env\.preview\.)?observability\.traces\]/m);
    expect(config).toMatch(/^compatibility_date\s*=\s*"2024-09-23"$/m);
  });
});
