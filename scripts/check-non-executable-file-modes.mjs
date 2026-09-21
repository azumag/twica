import { execFileSync } from "node:child_process";
import path from "node:path";

const NON_EXECUTABLE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".cts",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".scss",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const ROOT_NON_EXECUTABLE_FILES = new Set([
  ".env.local.example",
  ".gitattributes",
  ".gitignore",
  ".node-version",
  "AGENTS.md",
  "CLAUDE.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "eslint.config.mjs",
  "eslint.i18n.config.mjs",
  "next.config.ts",
  "open-next.config.ts",
  "package-lock.json",
  "package.json",
  "postcss.config.mjs",
  "tsconfig.json",
  "vitest.config.ts",
  "wrangler.toml",
]);

function isGuardedPath(filePath) {
  return (
    filePath.startsWith("src/") ||
    filePath.startsWith("workers/") ||
    filePath.startsWith("tests/") ||
    filePath.startsWith("analysis/") ||
    filePath.startsWith("messages/") ||
    filePath.startsWith("docs/") ||
    filePath.startsWith("config/") ||
    filePath.startsWith("e2e/") ||
    filePath.startsWith("db/") ||
    filePath.startsWith("supabase/") ||
    filePath.startsWith(".github/")
  );
}

function isNonExecutableFile(filePath) {
  if (ROOT_NON_EXECUTABLE_FILES.has(filePath)) {
    return true;
  }

  return (
    isGuardedPath(filePath) &&
    NON_EXECUTABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
  );
}

const stagedFiles = execFileSync("git", ["ls-files", "--stage", "-z"], {
  encoding: "utf8",
});

const offenders = [];
for (const entry of stagedFiles.split("\0")) {
  if (!entry) continue;

  const separator = entry.indexOf("\t");
  if (separator === -1) {
    throw new Error(`Unexpected git ls-files --stage record: ${entry}`);
  }

  const [mode] = entry.slice(0, separator).split(" ");
  const filePath = entry.slice(separator + 1);

  if (mode === "100755" && isNonExecutableFile(filePath)) {
    offenders.push(filePath);
  }
}

if (offenders.length > 0) {
  console.error(
    "Non-executable source/config/doc files must not carry the executable bit:",
  );
  for (const filePath of offenders.sort()) {
    console.error(`- ${filePath}`);
  }
  process.exitCode = 1;
} else {
  console.log("Tracked source/config/doc file modes are normalized.");
}
