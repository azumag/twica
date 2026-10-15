import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string) {
  return readFileSync(path, "utf8");
}

describe("chat-delivery deploy preparation (#1665)", () => {
  it("builds both chat-delivery environments as auxiliary Worker artifacts", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

    expect(pkg.scripts["chat-delivery:typecheck"]).toBe(
      "tsc -p workers/chat-delivery/tsconfig.json",
    );
    expect(pkg.scripts["chat-delivery:build:production"]).toContain(
      "workers/chat-delivery",
    );
    expect(pkg.scripts["chat-delivery:build:preview"]).toContain("--env preview");
    expect(pkg.scripts["auxiliary-workers:build"]).toContain(
      "chat-delivery:build:production",
    );
    expect(pkg.scripts["auxiliary-workers:build"]).toContain(
      "chat-delivery:build:preview",
    );
  });

  it("keeps real deployment behind an explicit repository variable", () => {
    const workflow = read(".github/workflows/deploy-cloudflare.yml");

    expect(workflow).toContain("chat-delivery:");
    expect(workflow).toContain(
      "if: vars.CHAT_DELIVERY_DEPLOY_ENABLED == 'true'",
    );
    expect(workflow).toContain("npm run chat-delivery:deploy:preview");
    expect(workflow).toContain("npm run chat-delivery:deploy");
  });

  it("requires chat-delivery bundles in the Supabase shutdown artifact guard", () => {
    const guard = read("scripts/check-supabase-shutdown.js");

    expect(guard).toContain("--require-chat-delivery-production");
    expect(guard).toContain("workers/chat-delivery/dist/production/index.js");
    expect(guard).toContain("--require-chat-delivery-preview");
    expect(guard).toContain("workers/chat-delivery/dist/preview/index.js");
  });

  it("does not enable dispatch or add the production app Queue producer binding yet", () => {
    const rootWrangler = read("wrangler.toml");
    const workerWrangler = read("workers/chat-delivery/wrangler.toml");

    // Step 3 (preview): the preview queue created on 2026-10-08 may now be
    // bound to twica-preview, but production queue/binding and the dispatch flag
    // stay absent until Step 3 unifies delivery owners and Step 5 provisions
    // production resources.
    expect(rootWrangler).not.toContain("[[queues.producers]]");
    expect(rootWrangler).not.toContain("CHAT_DELIVERY_DISPATCH_ENABLED");
    expect(workerWrangler).not.toContain("CHAT_DELIVERY_DISPATCH_ENABLED =");
  });
});
