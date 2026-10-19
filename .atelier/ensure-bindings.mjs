#!/usr/bin/env node
// postinstall: npm sometimes skips the optional native binding of the current
// platform (npm/cli#4828; seen with rolldown, used by Vitest), even with a
// complete package-lock.json. Tests then fail with "Cannot find native binding".
// This installs the missing platform bindings listed in the lockfile, without
// touching package.json or package-lock.json.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
// Only when this package is the project being installed, not a dependency.
if (process.env.INIT_CWD && path.resolve(process.env.INIT_CWD) !== root) process.exit(0);
const lockFile = path.join(root, "package-lock.json");
if (!fs.existsSync(lockFile)) process.exit(0);

const { packages = {} } = JSON.parse(fs.readFileSync(lockFile, "utf8"));
const isMusl = process.platform === "linux" && !process.report?.getReport?.().header?.glibcVersionRuntime;
const missing = Object.entries(packages)
  .filter(([key, meta]) => /node_modules\/@[^/]+\/binding-/.test(key) && meta.optional)
  .filter(([, meta]) => (!meta.os || meta.os.includes(process.platform)) && (!meta.cpu || meta.cpu.includes(process.arch)))
  .filter(([key]) => process.platform !== "linux" || (isMusl ? key.includes("musl") : !key.includes("musl")))
  .filter(([key]) => !fs.existsSync(path.join(root, key, "package.json")))
  .map(([key, meta]) => `${key.replace(/^.*node_modules\//, "")}@${meta.version}`);

if (missing.length) {
  console.log(`ensure-bindings: installing ${missing.join(", ")}`);
  const res = spawnSync(`npm install --no-save --no-audit --no-fund ${missing.join(" ")}`, { cwd: root, shell: true, stdio: "inherit" });
  process.exit(res.status ?? 1);
}
