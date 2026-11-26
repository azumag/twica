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

  it("rootとpreviewの両方でWorkers Logsを有効化する (#2114)", () => {
    const workerWrangler = read("workers/chat-delivery/wrangler.toml");

    // #2114: preview実経路ゲートではcron実行形跡があるのにcf o11yへ
    // イベントが出なかった。root/previewの両方へ明示した有効化を退行させない。
    // 既存のoverlay-realtime/rate-limitと同じ最小構成を採用したことを、
    // 両環境の表と有効化行の行頭一致で固定する（コメント中の同名表を
    // 有効化と誤認しないため）。
    expect(workerWrangler).toMatch(/^\[observability\]\nenabled = true$/m);
    expect(workerWrangler).toMatch(/^\[env\.preview\.observability\]\nenabled = true$/m);
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

  it("provisions the production app Queue producer binding in Step 5 (flag stays off by default)", () => {
    const rootWrangler = read("wrangler.toml");
    const workerWrangler = read("workers/chat-delivery/wrangler.toml");

    // Step 5 (production): the production queue (chat-notification-wakeup) is
    // now provisioned and bound to the production app. Dispatch itself remains
    // gated by the CHAT_DELIVERY_DISPATCH_ENABLED secret (off until flag
    // activation), so the binding alone does not enable delivery.
    expect(rootWrangler).toContain("[[queues.producers]]");
    expect(rootWrangler).toContain("chat-notification-wakeup");
    expect(rootWrangler).not.toContain("CHAT_DELIVERY_DISPATCH_ENABLED");
    expect(workerWrangler).not.toContain("CHAT_DELIVERY_DISPATCH_ENABLED =");
  });
});
