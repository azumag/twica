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
  it("pins CI Node.js to a fixed 22.x patch and keeps Workers Builds on the 22 major", () => {
    // 2026-10-21 の Node.js security release では 22.23.4 が修正版（Refs #1914）。
    // CI（GitHub Actions）は `.github/ci-node-version` で修正版へ完全固定する。メジャー（"22"）だけだと
    // actions/setup-node は runner のツールキャッシュにある旧パッチ（22.23.3）を選び、修正版が
    // 適用されないため。このファイルは setup-node が版として読むので、コメントは入れられない。
    //
    // 一方 Cloudflare Workers Builds は、完全指定の `.node-version`（22.23.4）では
    // `Installing nodejs 22.23.4` の直後に "Failed: error occurred while installing tools or
    // dependencies" となり全ビルドが失敗した（2026-10-21 実測。build f2aaabd8 / 2a8c9d68 / 6a27ed21。
    // 末尾改行の有無は無関係だった）。`.node-version` = `22` なら Workers Builds が自身の把握する
    // 22 系最新（同日時点は 22.23.3）に解決して成功する。
    // そこで CI 用ピンと Workers Builds 用 `.node-version` を暫定的に別ファイルへ分けている。
    // Workers Builds が 22.23.4 に対応した時点で一本化する（Refs #1914, #1919）。
    //
    // CI 側の下限（22.23.4 以上）を設けるのは、将来の巻き戻しや誤った downgrade で
    // 脆弱な版へ戻ることを防ぐため。比較は文字列ではなく数値で行う（22.23.10 > 22.23.4）。
    const ciVersion = readFileSync(join(root, ".github/ci-node-version"), "utf8").trim();
    expect(ciVersion).toMatch(/^22\.\d+\.\d+$/);
    const parse = (v: string) => v.split(".").map(Number);
    const atLeast = (actual: string, minimum: string) => {
      const a = parse(actual);
      const m = parse(minimum);
      for (let i = 0; i < m.length; i++) {
        if (a[i] !== m[i]) return a[i] > m[i];
      }
      return true;
    };
    expect(atLeast(ciVersion, "22.23.4")).toBe(true);

    // Workers Builds 用。完全指定にするとインストールに失敗するため、暫定でメジャーのみ（#1919 で一本化）。
    expect(readFileSync(join(root, ".node-version"), "utf8").trim()).toBe("22");

    // actions/setup-node を使う workflow は例外なく `.github/ci-node-version` を参照し、
    // node-version の直書き（EOL の Node 20 など）を持たないこと。
    // 新しい workflow が追加されても漏れないよう、ファイル一覧は動的に取得する。
    const workflowDir = join(root, ".github/workflows");
    const workflows = readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f));
    expect(workflows.length).toBeGreaterThan(0);
    for (const workflow of workflows) {
      const text = readFileSync(join(workflowDir, workflow), "utf8");
      if (!text.includes("actions/setup-node")) continue;
      expect(text, `${workflow} must use node-version-file`).toContain(
        "node-version-file: .github/ci-node-version",
      );
      expect(text, `${workflow} must not hardcode node-version`).not.toMatch(/^\s*node-version:/m);
    }
  });
  it("does not enable separately billed tracing or change the runtime date", () => {
    expect(config).not.toMatch(/^\[(?:env\.preview\.)?observability\.traces\]/m);
    expect(config).toMatch(/^compatibility_date\s*=\s*"2024-09-23"$/m);
  });
});
