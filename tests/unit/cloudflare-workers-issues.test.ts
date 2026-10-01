import { readFileSync } from "node:fs";
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
  it("uses the required Node major for both CI and the deployment toolchain", () => {
    expect(readFileSync(join(root, ".node-version"), "utf8").trim()).toBe("22");
    for (const workflow of ["ci.yml", "deploy-cloudflare.yml"]) {
      const text = readFileSync(join(root, ".github/workflows", workflow), "utf8");
      expect(text).toContain("node-version-file: .node-version");
      expect(text).not.toMatch(/node-version:\s*["']?20/);
    }
  });
  it("does not enable separately billed tracing or change the runtime date", () => {
    expect(config).not.toMatch(/^\[(?:env\.preview\.)?observability\.traces\]/m);
    expect(config).toMatch(/^compatibility_date\s*=\s*"2024-09-23"$/m);
  });
});
