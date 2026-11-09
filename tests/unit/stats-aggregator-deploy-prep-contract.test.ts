import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

function readStatsDeployJob() {
  const workflow = read(".github/workflows/deploy-cloudflare.yml");
  const start = workflow.indexOf("\n  stats-aggregator:");
  if (start < 0) throw new Error("stats-aggregator deploy job is missing");
  const tail = workflow.slice(start + 1);
  const nextJob = tail.slice(1).search(/\n  [a-z][\w-]*:/);
  return nextJob < 0 ? tail : tail.slice(0, nextJob + 1);
}

// Only interpret the bounded deployment predicate grammar. Keeping the event
// discriminator explicit prevents a manual target from also selecting its ref.
function selectsDeployTarget(
  condition: string,
  event: string,
  ref: string,
  input: string,
) {
  const match = condition.match(
    /^\(github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.environment == '(preview|production)'\) \|\| \(github\.event_name == 'push' && github\.ref == '(refs\/heads\/(?:preview|main))'\)$/,
  );
  if (!match) throw new Error(`Unexpected deploy predicate: ${condition}`);
  return (event === "workflow_dispatch" && input === match[1])
    || (event === "push" && ref === match[2]);
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
    const job = readStatsDeployJob();
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

  it.each([
    { event: "push", ref: "refs/heads/main", input: "", expected: "production" },
    { event: "push", ref: "refs/heads/preview", input: "", expected: "preview" },
    { event: "workflow_dispatch", ref: "refs/heads/main", input: "preview", expected: "preview" },
    { event: "workflow_dispatch", ref: "refs/heads/main", input: "production", expected: "production" },
    { event: "workflow_dispatch", ref: "refs/heads/preview", input: "preview", expected: "preview" },
    { event: "workflow_dispatch", ref: "refs/heads/preview", input: "production", expected: "production" },
    { event: "workflow_dispatch", ref: "refs/heads/feature", input: "preview", expected: "preview" },
    { event: "workflow_dispatch", ref: "refs/heads/feature", input: "production", expected: "production" },
  ])("selects only $expected for $event $ref ($input)", ({ event, ref, input, expected }) => {
    const job = readStatsDeployJob();
    const conditions = [...job.matchAll(/^        if: \$\{\{ (.*?) \}\}$/gm)]
      .map((match) => match[1]);
    // Build and deploy must select the same, single environment.
    expect(conditions).toHaveLength(4);
    expect(conditions.map((condition) => selectsDeployTarget(condition, event, ref, input)))
      .toEqual([
        expected === "preview",
        expected === "production",
        expected === "preview",
        expected === "production",
      ]);
  });

  it("scans stats bundles with the complete generated-bundle rules", () => {
    const guard = read("scripts/check-supabase-shutdown.js");
    const generatedScan = guard.match(
      /for \(const artifactRoot of \[([\s\S]*?)\n\]\) \{\n  for \(const file of walk\(artifactRoot\)\) \{\n    assertAbsent\(file, generatedBundlePatterns\)\n  \}\n\}/,
    );
    expect(generatedScan).not.toBeNull();
    expect(generatedScan?.[1]).toContain("'workers/stats-aggregator/dist'");

    // Require only exported pure helpers; importing the guard does not run its
    // CLI, create bundle files, or access a deployed Worker.
    const { findGeneratedBundleDependencies } = createRequire(import.meta.url)(
      "../../scripts/check-supabase-shutdown.js",
    ) as { findGeneratedBundleDependencies: (source: string) => string[] };

    expect(findGeneratedBundleDependencies("export default {};")).toEqual([]);
    expect(findGeneratedBundleDependencies("// @supabase/realtime-js phx_join\nexport default {};"))
      .toEqual([]);
    for (const source of [
      "const moduleId = '@supabase/realtime-js';",
      "const eventName = 'phx_join';",
      "const eventName = 'postgres_changes';",
    ]) {
      expect(findGeneratedBundleDependencies(source)).not.toEqual([]);
    }
  });
});
