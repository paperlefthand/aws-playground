/**
 * `vp run verify:bundle` のエントリポイント。
 *
 * ビルド成果物の JS に `eval` / `new Function` が混ざっていないことを検査する。
 * 混ざっていると CSP から `'unsafe-eval'` を外せなくなり、実験の前提が崩れる
 * (SPEC 1 の禁止事項)。混入を見つけたら **CSP を緩めるのではなく**
 * 原因のライブラリを特定して差し替えること。
 */
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { exit } from "node:process";
import { findForbiddenRuntimeApis } from "./check-bundle.mjs";

const distDir = process.argv[2];
if (!distDir) {
  console.error("usage: node verify-bundle.mjs <dist-dir>");
  exit(2);
}

const assetsDir = path.join(distDir, "assets");
let files;
try {
  files = readdirSync(assetsDir).filter((file) => file.endsWith(".js"));
} catch {
  console.error(`verify:bundle: ${assetsDir} を読めません。先に \`vp build\` を実行してください。`);
  exit(2);
}

let failed = false;
for (const file of files) {
  const js = readFileSync(path.join(assetsDir, file), "utf8");
  for (const finding of findForbiddenRuntimeApis(js)) {
    failed = true;
    console.error(`verify:bundle: NG — ${file} に ${finding.name} が ${finding.count} 件`);
    console.error(`  例: …${finding.sample}…`);
  }
}

if (failed) {
  console.error(
    "CSP の 'unsafe-eval' を足して回避しないこと(SPEC 6)。原因のライブラリを差し替えるか docs/OPEN_QUESTIONS.md に上げてください。",
  );
  exit(1);
}

console.log(`verify:bundle: OK — ${files.length} 個の JS に eval / new Function なし`);
