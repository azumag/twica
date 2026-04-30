import { describe, expect, it } from "vitest";

import config from "../../open-next.config";

describe("open-next.config", () => {
  it("uses the Cloudflare config helper while preserving existing runtime overrides", () => {
    expect(config.default.override.wrapper).toBe("cloudflare-node");
    expect(config.default.override.converter).toBe("edge");
    expect(config.default.override.proxyExternalRequest).toBe("fetch");
    expect(config.default.override.incrementalCache).toBe("dummy");
    expect(config.default.override.tagCache).toBe("dummy");
    expect(config.default.override.queue).toBe("direct");

    expect(config.edgeExternals).toContain("node:crypto");
    expect(config.middleware?.external).toBe(true);
    expect(config.middleware?.override?.wrapper).toBe("cloudflare-edge");
    expect(config.middleware?.override?.queue).toBe("direct");
    expect(config.cloudflare?.useWorkerdCondition).toBe(true);
  });
});
