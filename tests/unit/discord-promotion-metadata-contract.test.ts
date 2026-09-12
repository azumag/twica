import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(
  join(repositoryRoot, ".github/workflows/notify-discord-main-merge.yml"),
  "utf8"
);

describe("Discord promotion metadata rendering contract", () => {
  it("escapes Markdown control characters before rendering repository and author metadata", () => {
    expect(workflow).toContain("def escape_discord_markdown(value):");
    expect(workflow).toContain(
      'for marker in ("\\\\", "`", "*", "_", "~", "|"):'
    );
    expect(workflow).toContain(
      'repository_name = escape_discord_markdown(os.environ["REPOSITORY_NAME"])'
    );
    expect(workflow).toContain(
      'pr_author = escape_discord_markdown(os.environ["PR_AUTHOR"])'
    );
    expect(workflow).toContain(
      'prefix = f"🚀 **{repository_name} が更新されました**\\n\\n"'
    );
    expect(workflow).toContain('f"by {pr_author}\\n\\n"');
  });

  it("keeps normal refs as inline code but escapes refs that contain a backtick", () => {
    expect(workflow).toContain("def discord_inline_code(value):");
    expect(workflow).toContain('if "`" in value:');
    expect(workflow).toContain("return escape_discord_markdown(value)");
    expect(workflow).toContain('return f"`{value}`"');
    expect(workflow).toContain(
      'head_ref = discord_inline_code(os.environ["HEAD_REF"])'
    );
    expect(workflow).toContain('f"\\n\\n{head_ref} → main\\n"');
  });

  it("continues to suppress Discord mention parsing", () => {
    expect(workflow).toContain("allowed_mentions: {parse: []}");
  });
});
