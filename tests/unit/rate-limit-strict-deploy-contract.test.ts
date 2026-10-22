import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string) {
  return readFileSync(path, "utf8");
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
