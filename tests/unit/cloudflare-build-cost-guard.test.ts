import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const buildGuard = join(repositoryRoot, "scripts/cloudflare-workers-build.sh");
const deployGuard = join(repositoryRoot, "scripts/cloudflare-workers-build-deploy.sh");

function workersCiEnv(branch: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WORKERS_CI: "1",
    WORKERS_CI_BRANCH: branch,
  };
}

describe("Cloudflare Workers Build cost guard", () => {
  it("keeps the package build command behind the repository guard", () => {
    const packageJson = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8")
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts["workers:build"]).toBe(
      "bash scripts/cloudflare-workers-build.sh"
    );
  });

  it("skips the expensive OpenNext build on feature branches in Workers CI", () => {
    const result = spawnSync("bash", [buildGuard], {
      cwd: repositoryRoot,
      env: workersCiEnv("feature/cost-test"),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Skipping OpenNext build");
  });

  it("skips preview deploy/upload on feature branches in Workers CI", () => {
    for (const mode of ["deploy", "upload"] as const) {
      const result = spawnSync("bash", [deployGuard, "preview", mode], {
        cwd: repositoryRoot,
        env: workersCiEnv("feature/cost-test"),
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Skipping Cloudflare");
      expect(result.stdout).toContain("only 'preview' is deployable");
    }
  });
});
