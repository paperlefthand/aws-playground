/**
 * `vp run verify:vuln-mode` のエントリポイント。
 *
 * SPEC 4.6 の「`vulnMode` が false ならバンドルに含まれないこと」を実ビルドで
 * 確認する。tree-shaking はビルド設定の変更で静かに壊れるので、
 * 型検査や単体テストではなく **成果物そのもの** を見る。
 *
 * 手順:
 *   1. VITE_VULN_MODE=false でビルド → 目印が **無い** こと
 *   2. VITE_VULN_MODE=true  でビルド → 目印が **有る** こと(検査自体の妥当性確認)
 *   3. 最後に false でビルドし直し、脆弱ページを含む成果物を残さない
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { exit } from "node:process";
import { containsMarker } from "./check-bundle.mjs";

/** web/src/lab/VulnerableSearch.tsx の VULN_MODE_BUNDLE_MARKER と一致させること */
const MARKER = "lab-vulnerable-search-do-not-ship";
const DIST = "web/dist";

function build(vulnMode) {
  execFileSync("vp", ["build"], {
    stdio: "pipe",
    env: { ...process.env, VITE_VULN_MODE: vulnMode ? "true" : "false" },
  });
}

function bundleContainsMarker() {
  const assetsDir = path.join(DIST, "assets");
  return readdirSync(assetsDir)
    .filter((file) => file.endsWith(".js"))
    .some((file) => containsMarker(readFileSync(path.join(assetsDir, file), "utf8"), MARKER));
}

let failed = false;

build(false);
if (bundleContainsMarker()) {
  console.error(
    "verify:vuln-mode: NG — VITE_VULN_MODE=false のビルドに検証用ページが含まれています。" +
      "tree-shaking が効いていません(web/src/lab/flags.ts のコメント参照)。",
  );
  failed = true;
} else {
  console.log("verify:vuln-mode: OK — false のビルドに検証用ページなし");
}

build(true);
if (bundleContainsMarker()) {
  console.log("verify:vuln-mode: OK — true のビルドには含まれる(検査が機能している)");
} else {
  console.error(
    "verify:vuln-mode: NG — VITE_VULN_MODE=true でも目印が見つかりません。" +
      "目印の文字列がずれている可能性があります(検査が常に成功してしまう状態)。",
  );
  failed = true;
}

// 脆弱ページ入りの成果物を残さない
build(false);

exit(failed ? 1 : 0);
