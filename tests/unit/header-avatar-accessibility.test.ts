import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("Header avatar accessibility", () => {
  it("keeps the Twitch avatar decorative while exposing the display name separately", () => {
    const source = readSource("src/components/Header.tsx");
    const avatar = source.match(
      /<Image[\s\S]*?src=\{session\.twitchProfileImageUrl\}[\s\S]*?\/>/,
    )?.[0];

    expect(avatar).toBeDefined();
    expect(avatar).toContain('alt=""');
    expect(source.match(/\{session\.twitchDisplayName\}/g)).toHaveLength(2);
  });
});
