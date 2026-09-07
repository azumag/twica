import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  join(process.cwd(), ".github/workflows/notify-discord-main-merge.yml"),
  "utf8"
);

function validationCondition(source: string): string {
  const match = source.match(
    /validate-promotion-summary:\n\s+if: >-\n([\s\S]*?)\n\s+runs-on:/
  );
  return match?.[1] ?? "";
}

describe("Discord promotion validation fork guard", () => {
  it("skips the validation job for fork-owned preview branches", () => {
    const condition = validationCondition(workflow);

    expect(condition).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository"
    );
    expect(condition).toContain(
      "github.event.pull_request.head.ref == 'preview'"
    );
  });
});
