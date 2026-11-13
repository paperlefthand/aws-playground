/**
 * `vp run verify:no-inline` のエントリポイント。
 * 引数に渡されたビルド成果物 HTML を検査し、inline <script>/<style> が
 * あれば一覧を表示して exit 1 する。
 */
import { readFileSync } from "node:fs";
import { exit } from "node:process";
import { findInlineViolations } from "./check-no-inline.mjs";

const target = process.argv[2];
if (!target) {
  console.error("usage: node verify-no-inline.mjs <path-to-index.html>");
  exit(2);
}

let html;
try {
  html = readFileSync(target, "utf8");
} catch {
  console.error(`verify:no-inline: ${target} を読めません。先に \`vp build\` を実行してください。`);
  exit(2);
}

const violations = findInlineViolations(html);
if (violations.length > 0) {
  console.error(`verify:no-inline: NG — ${target} に inline 要素があります:`);
  for (const v of violations) {
    console.error(`  [${v.kind}] ${v.snippet}`);
  }
  exit(1);
}

console.log(`verify:no-inline: OK — ${target} に inline <script>/<style> なし`);
