import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("Cloudflare proxy migration policy", () => {
  it("keeps Edge Middleware while the current Cloudflare adapter rejects Next.js Proxy", () => {
    expect(existsSync(join(process.cwd(), "src/middleware.ts"))).toBe(true);
    expect(existsSync(join(process.cwd(), "src/proxy.ts"))).toBe(false);
  });

  it("documents the current package pin, upstream support, and verification gate", () => {
    const doc = readSource("docs/cloudflare-proxy-migration.md");
    const middleware = readSource("src/middleware.ts");
    const packageJson = JSON.parse(readSource("package.json")) as {
      devDependencies?: Record<string, string>;
    };
    const adapterVersion = packageJson.devDependencies?.["@opennextjs/cloudflare"];

    // Keep this contract on observable migration gates, not prose copied from
    // the policy document. Wording and future package pin changes should not
    // require duplicating the same version literal or explanatory sentence here.
    expect(adapterVersion).toBeDefined();
    expect(doc).toContain(`@opennextjs/cloudflare\` ${adapterVersion}`);
    expect(doc).toContain("opennextjs-cloudflare#1309");
    expect(doc).toContain("Upstream status last checked");
    expect(doc).toContain("npm run workers:build");
    expect(middleware).toContain("export async function middleware");
    expect(middleware).not.toContain("export async function proxy");
    expect(middleware).toContain("docs/cloudflare-proxy-migration.md");
  });
});
