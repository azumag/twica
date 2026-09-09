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

function pullRequestTargetTypes(source: string): string[] {
  const match = source.match(/pull_request_target:\n\s+types: \[([^\]]+)\]/);
  return (
    match?.[1]
      ?.split(",")
      .map((type) => type.trim())
      .filter(Boolean) ?? []
  );
}

function missingSummaryBranches(source: string): {
  promotion: string;
  directToMain: string;
} {
  const match = source.match(
    /if is_promotion:\n([\s\S]*?)\n\s+else:\n([\s\S]*?)\n\s+prefix =/
  );
  return {
    promotion: match?.[1] ?? "",
    directToMain: match?.[2] ?? "",
  };
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

  it("revalidates promotion summaries after reopen and ready-for-review transitions", () => {
    const eventTypes = pullRequestTargetTypes(workflow);

    expect(eventTypes).toContain("reopened");
    expect(eventTypes).toContain("ready_for_review");
  });

  it("keeps missing-summary warnings and failures limited to preview promotions", () => {
    expect(workflow).toContain(
      'os.environ.get("HEAD_REF") == promotion_source_ref'
    );
    expect(workflow).toContain(
      'os.environ.get("HEAD_REPOSITORY") == os.environ.get("GITHUB_REPOSITORY")'
    );

    const { promotion, directToMain } = missingSummaryBranches(workflow);

    expect(promotion).toContain("::warning::Promotion PR summary missing");
    expect(promotion).toContain("PROMOTION_SUMMARY_MISSING=true");
    expect(directToMain).toContain(
      "A direct-to-main merge has no promotion-summary contract."
    );
    expect(directToMain).not.toContain("::warning::");
    expect(directToMain).not.toContain("PROMOTION_SUMMARY_MISSING=true");
  });
});
