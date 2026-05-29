#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const platform = os.platform();
const arch = os.arch();

if (platform !== "darwin" || (arch !== "arm64" && arch !== "x64")) {
  process.exit(0);
}

const require = createRequire(import.meta.url);

let packageJsonPath;
try {
  packageJsonPath = require.resolve("node-pty/package.json");
} catch {
  process.exit(0);
}

const helperPath = path.join(
  path.dirname(packageJsonPath),
  "prebuilds",
  `darwin-${arch}`,
  "spawn-helper",
);

let stat;
try {
  stat = fs.statSync(helperPath);
} catch {
  process.exit(0);
}

if ((stat.mode & 0o111) !== 0) {
  process.exit(0);
}

fs.chmodSync(helperPath, stat.mode | 0o755);
