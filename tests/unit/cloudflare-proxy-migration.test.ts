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

  it("documents the current pin, upstream support, and verification gate", () => {
    const doc = readSource("docs/cloudflare-proxy-migration.md");
    const middleware = readSource("src/middleware.ts");

    expect(doc).toContain("Node.js middleware is not currently supported");
    expect(doc).toContain("Do not add `src/proxy.ts` yet");
    expect(doc).toContain("@opennextjs/cloudflare` 1.20.2");
    expect(doc).toContain("opennextjs-cloudflare#1309");
    expect(doc).toContain("1.20.3");
    expect(doc).toContain("Upstream status last checked");
    expect(doc).toContain("npm run workers:build");
    expect(middleware).toContain("export async function middleware");
    expect(middleware).not.toContain("export async function proxy");
    expect(middleware).toContain("intentionally stays on the deprecated middleware.ts convention");
  });
});
