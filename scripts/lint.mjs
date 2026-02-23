import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const IGNORE_DIRS = new Set([".git", "node_modules"]);

function collectJsFiles(dir) {
  const entries = readdirSync(dir);
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      if (!IGNORE_DIRS.has(entry)) {
        files.push(...collectJsFiles(fullPath));
      }
      continue;
    }

    if (entry.endsWith(".js") || entry.endsWith(".mjs")) {
      files.push(fullPath);
    }
  }

  return files;
}

const files = collectJsFiles(ROOT);
for (const file of files) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

console.log(`Syntax check passed for ${files.length} file(s).`);
