#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const buildDir = "./.aws-sam/build/UserServiceFunction";
const srcDir = "./src";

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".js.map")) out.push(p);
  }
  return out;
}

for (const mapPath of walk(buildDir)) {
  const map = JSON.parse(readFileSync(mapPath, "utf8"));
  map.sources = map.sources.map((s) => {
    const basename = s.replace(/^.*[\\/](?:tmp[^\\/]+[\\/])/, "");
    const abs = join(srcDir, basename);
    return relative(dirname(mapPath), abs).replace(/\\/g, "/");
  });
  map.sourceRoot = "";
  delete map.sourcesContent;
  writeFileSync(mapPath, JSON.stringify(map));
  console.log(`rewrote ${mapPath}`);
}
