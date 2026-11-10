import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string) {
  return readFileSync(path, "utf8");
}

// `on:` ブロック（jobs: 等の非インデント行まで）から、トリガキー名の一覧を
// 抽出する。workflow_dispatch 以外のトリガ（push/pull_request/workflow_call 等）
// が後方に追加されても検出できるよう、キー列挙への依存を持たない構造比較に使う。
// トリガキーは `on:` 直下でインデント2つの行として現れる（それより深い行は
// inputs/confirm 等のネストした設定値）。
function triggerKeysOf(workflow: string): string[] {
  const onBlock = workflow.match(/on:\n((?:\s{2,}[^\n]*\n?)+)/)?.[1] ?? "";
  return onBlock
    .split("\n")
    .filter((line) => /^ {2}\S/.test(line))
    .map((line) => line.trim().split(":")[0]);
}

/**
 * #1888: strict レート制限の Durable Object は専用 Worker として配備する。
 * アプリ本体の entrypoint は OpenNext の生成物なので class を export できず、
 * `script_name` 付き binding で参照する必要がある。設定のドリフトと、承認前の
 * 自動配備をここで固定する。
 */
describe("strict rate-limit Durable Object deploy contract (#1888)", () => {
  it("declares the production Durable Object binding and v1 migration", () => {
    const config = read("workers/rate-limit/wrangler.toml");

    expect(config).toContain('name = "twica-rate-limit"');
    expect(config).toContain('main = "src/index.ts"');
    expect(config).toContain("[[durable_objects.bindings]]");
    expect(config).toContain('name = "STRICT_RATE_LIMITER"');
    expect(config).toContain('class_name = "StrictRateLimitDurableObject"');
    expect(config).toContain("[[migrations]]");
    expect(config).toContain('tag = "v1"');
    expect(config).toContain('new_sqlite_classes = ["StrictRateLimitDurableObject"]');
  });

  it("declares the preview Worker separately because env arrays are replaced", () => {
    const config = read("workers/rate-limit/wrangler.toml");

    expect(config).toContain("[env.preview]");
    expect(config).toContain('name = "twica-rate-limit-preview"');
    expect(config).toContain("[[env.preview.durable_objects.bindings]]");
    expect(config).toContain("[[env.preview.migrations]]");
    expect(config).toContain(
      'new_sqlite_classes = ["StrictRateLimitDurableObject"]',
    );
  });

  it("exports the class the migration creates and a module-worker entrypoint", () => {
    const source = read("workers/rate-limit/src/index.ts");

    expect(source).toContain("export class StrictRateLimitDurableObject");
    // Durable Objects require a module worker, so the Worker needs a default
    // export; without one wrangler falls back to service-worker format and
    // rejects the binding.
    expect(source).toContain("export default");
  });

  it("keeps deploy commands available but out of the automatic workflow", () => {
    const pkg = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts["rate-limit:typecheck"]).toBe(
      "tsc -p workers/rate-limit/tsconfig.json",
    );
    expect(pkg.scripts["rate-limit:build:production"]).toContain("--env=\"\"");
    expect(pkg.scripts["rate-limit:build:preview"]).toContain("--env preview");
    expect(pkg.scripts["rate-limit:deploy"]).toContain(
      "workers/rate-limit/wrangler.toml",
    );
    expect(pkg.scripts["auxiliary-workers:build"]).toContain(
      "rate-limit:build:production",
    );
    expect(pkg.scripts["auxiliary-workers:build"]).toContain(
      "rate-limit:build:preview",
    );

    const workflow = read(".github/workflows/deploy-cloudflare.yml");
    // Provisioning a new Cloudflare resource needs explicit approval (#1888);
    // merging code must not create it.
    expect(workflow).not.toContain("rate-limit:deploy");
  });

  it("keeps both dispatch workflows manual, confirm-gated, and read-only", () => {
    // 本番配備は gated dispatch でのみ行う。自動トリガの混入・権限拡大・
    // confirm ゲートの消失をここで固定する（#1888 の有効化ゲート）。
    for (const [file, env, script, confirmToken] of [
      // #2041: confirm トークンは環境ごとに別物（production は 'deploy-production'）。
      // preview/production の dispatch を誤って混同して実行しないよう、
      // ゲート式のトークンを workflow ごとに固定する。
      [".github/workflows/deploy-rate-limit.yml", "environment: preview", "rate-limit:deploy:preview", "deploy"],
      [".github/workflows/deploy-rate-limit-production.yml", "environment: production", "rate-limit:deploy", "deploy-production"],
    ] as const) {
      const workflow = read(file);
      expect(workflow).toContain("workflow_dispatch:");
      // workflow_dispatch 専用であることを、`on:` ブロックのトリガキー一覧の
      // 構造比較で固定する（DSH 必須指摘: キー列挙方式だと workflow_call 等の
      // 列挙漏れで uses: 経由の deploy が可能になる）。
      expect(triggerKeysOf(workflow)).toEqual(["workflow_dispatch"]);
      expect(workflow).toContain(`confirm == '${confirmToken}'`);
      // クロス環境トークン混同の防止（DSH 強く推奨）: production に preview の
      // トークン、preview に production のトークンが紛れ込まないことを確認。
      // 'deploy-production' は 'deploy' を前方一致で含むため、逆方向の混同は
      // 文字列比較では検出できない点に注意（ゲート式自体を正確に照合する）。
      if (confirmToken === "deploy") {
        expect(workflow).not.toContain("'deploy-production'");
      } else {
        expect(workflow).not.toContain("confirm == 'deploy'");
      }
      // description も同じトークンを案内すること（UI 上の誤入力防止）。
      expect(workflow).toContain(`'${confirmToken}'`);
      expect(workflow).toContain("contents: read");
      // DSH 任意指摘2: `contents: read` の文字列一致だけでは、contents: write や
      // id-token: write 等の権限併記を検出できない。permissions: ブロックを
      // 抽出して contents: read 単独であることを確認する。
      const permissionsBody =
        workflow.match(/permissions:\n((?:\s{6,}[^\n]*\n?)+)/)?.[1] ?? "";
      expect(
        permissionsBody
          .trim()
          .split("\n")
          .map((line) => line.trim())
      ).toEqual(["contents: read"]);
      expect(workflow).toContain(env);
      expect(workflow).toContain(`npm run ${script}`);
      // 同時デプロイ抑止
      expect(workflow).toContain("concurrency:");
      expect(workflow).toContain("cancel-in-progress: false");
    }
  });

  it("detects a second trigger added after workflow_dispatch (mutation fixture)", () => {
    // アサーション自体の回帰確認: workflow_call を後方に足した変異が
    // FAIL になることを固定する（DSH 必須指摘の変異確認ケース）。
    const mutated = read(".github/workflows/deploy-rate-limit-production.yml").replace(
      "workflow_dispatch:",
      "workflow_dispatch:\n  workflow_call:",
    );
    expect(triggerKeysOf(mutated)).toEqual(["workflow_dispatch", "workflow_call"]);
  });

  it("documents the app binding only after the DO Worker is deployed", () => {
    const docs = read("docs/rate-limit-backend-policy.md");

    expect(docs).toContain("Durable Object Worker の配備 (#1888)");
    expect(docs).toContain('script_name = "twica-rate-limit"');
    expect(docs).toContain('script_name = "twica-rate-limit-preview"');
    expect(docs).toMatch(/配備順序を逆にすると/);
  });

  it("wires only the preview app binding to the dedicated DO Worker namespace", () => {
    const config = read("wrangler.toml");

    // binding 形式は DO namespace (idFromName / get を持つ) でなければならない。
    // HTTP services 形式 ([[services]]) は fetch しか持たないため、誤って
    // services として配線すると runtime で idFromName が TypeError → catch →
    // 503 fail-closed になり、authLogin / activateCode が恒常的に失敗する
    // (#1888 で services 版の未コミット差分が実際にこの欠陥を含んでいた)。
    expect(config).toContain("[[env.preview.durable_objects.bindings]]");
    expect(config).toContain('name = "STRICT_RATE_LIMITER"');
    expect(config).toContain('class_name = "StrictRateLimitDurableObject"');
    expect(config).toContain('script_name = "twica-rate-limit-preview"');
    expect(config).not.toContain('service = "twica-rate-limit');
    // production (top-level env) の有効化は policy doc の有効化ゲート 4 どおり
    // 別承認のため、binding は preview env にのみ置く。`[["durable_objects..."]]
    // の top-level 宣言は preview env 宣言と前置きが異なるので部分一致で区別できる。
    expect(config).not.toContain("[[durable_objects.bindings]]");
  });
});
