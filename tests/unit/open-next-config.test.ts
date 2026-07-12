import { describe, expect, it } from "vitest";

import config from "../../open-next.config";

describe("open-next.config", () => {
  it("uses the Cloudflare config helper while preserving existing runtime overrides", () => {
    // `FunctionOptions.override` は optional なため `config.default.override` は
    // `OverrideOptions | undefined` 型になる。non-null assertion(!)ではなく、
    // 未定義なら即座にテスト失敗として扱う型ガードで安全に絞り込む。
    const defaultOverride = config.default.override;
    if (!defaultOverride) {
      throw new Error("config.default.override should be defined by defineCloudflareConfig");
    }
    expect(defaultOverride.wrapper).toBe("cloudflare-node");
    expect(defaultOverride.converter).toBe("edge");
    expect(defaultOverride.proxyExternalRequest).toBe("fetch");
    expect(defaultOverride.incrementalCache).toBe("dummy");
    expect(defaultOverride.tagCache).toBe("dummy");
    expect(defaultOverride.queue).toBe("direct");

    expect(config.edgeExternals).toContain("node:crypto");

    // `config.middleware` は `ExternalMiddlewareConfig | InternalMiddlewareConfig` の
    // 判別共用体で、`override` は `external: true` 側(ExternalMiddlewareConfig)にしか
    // 存在しない。`external` の真偽値で絞り込むことで `override` へ安全にアクセスする。
    const middleware = config.middleware;
    if (!middleware || !middleware.external) {
      throw new Error("config.middleware should be configured as external middleware");
    }
    expect(middleware.external).toBe(true);
    expect(middleware.override?.wrapper).toBe("cloudflare-edge");
    expect(middleware.override?.queue).toBe("direct");
    expect(config.cloudflare?.useWorkerdCondition).toBe(true);
  });
});
