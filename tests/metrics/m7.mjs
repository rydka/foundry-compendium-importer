// M7 (recorded, not blocking): lines in scripts/ and functions defined more than once.
//   node tests/metrics/m7.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../scripts", import.meta.url));
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const full = path.join(dir, n);
  return statSync(full).isDirectory() ? walk(full) : [full];
});
const files = walk(root).filter((f) => /\.m?js$/.test(f));
let lines = 0;
const seen = new Map();
for (const f of files) {
  const text = readFileSync(f, "utf8");
  lines += text.split("\n").length;
  for (const m of text.matchAll(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) {
    seen.set(m[1], [...(seen.get(m[1]) ?? []), path.relative(root, f)]);
  }
}
const duplicates = [...seen].filter(([, w]) => w.length > 1).map(([n]) => n);
console.log(JSON.stringify({ lines, target: 1100, duplicates }, null, 2));
