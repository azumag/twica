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

function isGuardedPath(filePath) {
  return (
    filePath.startsWith("src/") ||
    filePath.startsWith("workers/") ||
    filePath.startsWith("tests/") ||
    filePath.startsWith("analysis/src/") ||
    filePath.startsWith("messages/") ||
    filePath.startsWith("docs/") ||
    filePath.startsWith("config/") ||
    filePath.startsWith(".github/workflows/")
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
  const extension = path.extname(filePath).toLowerCase();

  if (
    mode === "100755" &&
    isGuardedPath(filePath) &&
    NON_EXECUTABLE_EXTENSIONS.has(extension)
  ) {
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
