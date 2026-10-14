import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

/**
 * Issue #741 の cron Worker (`workers/stats-aggregator`) 配備準備。
 *
 * PR #1764 は Worker のコードと build script までを用意し、deploy 配線は
 * 「chat-delivery と同じ導入順序」として残していた。この契約テストは
 * その配線が opt-in のまま存在することを固定する:
 * - コードをマージしただけでは動かない (`vars.STATS_AGGREGATOR_DEPLOY_ENABLED`)
 * - secret・backfill を前提としない (ここでは secret を要求しない)
 * - CI の Supabase shutdown guard が両環境の成果物を検査対象に含める
 */
describe("stats-aggregator deploy preparation (#741)", () => {
  it("exposes both deploy environments through repository scripts", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

    expect(pkg.scripts["stats-aggregator:deploy"]).toBe(
      "OPEN_NEXT_DEPLOY=true wrangler deploy --config workers/stats-aggregator/wrangler.toml",
    );
    expect(pkg.scripts["stats-aggregator:deploy:preview"]).toContain("--env preview");
    expect(pkg.scripts["stats-aggregator:deploy:preview"]).toContain(
      "workers/stats-aggregator/wrangler.toml",
    );
    // CI は `--require-aux-workers` で全構成の成果物を必須化するため、
    // build 対象に入っていない成果物を guard すると CI が赤くなる。
    for (const script of [
      "stats-aggregator:build:production",
      "stats-aggregator:build:preview",
    ]) {
      expect(pkg.scripts["auxiliary-workers:build"]).toContain(script);
    }
  });

  it("keeps real deployment behind an explicit repository variable", () => {
    const workflow = read(".github/workflows/deploy-cloudflare.yml");
    const job = workflow.slice(workflow.indexOf("\n  stats-aggregator:"));
    // deploy job は chat-delivery と同じ detect/build/deploy 構成を保つ。
    expect(job).toContain("if: vars.STATS_AGGREGATOR_DEPLOY_ENABLED == 'true'");
    expect(job).toContain("npm run stats-aggregator:typecheck");
    expect(job).toContain("npm run stats-aggregator:build:preview");
    expect(job).toContain("npm run stats-aggregator:build:production");
    expect(job).toContain("npm run stats-aggregator:deploy:preview");
    expect(job).toContain("npm run stats-aggregator:deploy");
    // build した成果物を必ず guard する (silent pass 防止)。
    expect(job).toContain("--require-stats-aggregator-preview");
    expect(job).toContain("--require-stats-aggregator-production");
  });

  it("requires both stats-aggregator bundles in the Supabase shutdown guard", () => {
    const guard = read("scripts/check-supabase-shutdown.js");

    expect(guard).toContain("--require-stats-aggregator-production");
    expect(guard).toContain("workers/stats-aggregator/dist/production/index.js");
    expect(guard).toContain("--require-stats-aggregator-preview");
    expect(guard).toContain("workers/stats-aggregator/dist/preview/index.js");
  });

  it("keeps the cron Worker free of database credentials and bindings", () => {
    const workerPkg = JSON.parse(read("workers/stats-aggregator/package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    // 設定行だけを見る。コメントには経緯として "Supabase依存を持たない" 等の
    // 記述があり、それを禁止語として扱うと意図と逆の検査になる。
    const workerWrangler = read("workers/stats-aggregator/wrangler.toml")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

    // #711 の教訓: Worker 側に DB 直結を持たせると cutover 後に無音停止しうる。
    // 集計は本体アプリの内部API経由に限定する。
    for (const deps of [workerPkg.dependencies ?? {}, workerPkg.devDependencies ?? {}]) {
      for (const name of Object.keys(deps)) {
        expect(name).not.toMatch(/supabase|postgres|drizzle|hyperdrive/i);
      }
    }
    expect(workerWrangler).not.toMatch(/hyperdrive|PLANETSCALE|DATABASE_URL|SUPABASE/i);
    expect(workerWrangler).toContain('crons = ["5 * * * *"]');
  });
});
