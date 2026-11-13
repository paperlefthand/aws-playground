/**
 * `vp run gen:env` のエントリポイント。
 *
 * CDK の出力ファイルから `web/.env.local` を生成する。値を手書きさせないための
 * 仕組み(SPEC 4.6)。
 *
 *   cdk deploy --all --outputs-file cdk-outputs.json   # infra/ で実行
 *   vp run gen:env                                     # リポジトリルートで実行
 *
 * 検証用の脆弱ページを含めてビルドしたいときは `--vuln-mode` を付ける(実験 E8)。
 */
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { argv, exit } from "node:process";
import { buildEnvFile } from "./build-env.mjs";

const DEFAULT_OUTPUTS = "infra/cdk-outputs.json";
const TARGET = "web/.env.local";

const args = argv.slice(2);
const vulnMode = args.includes("--vuln-mode");
const outputsPath = args.find((arg) => !arg.startsWith("--")) ?? DEFAULT_OUTPUTS;

let outputs;
try {
  outputs = JSON.parse(readFileSync(outputsPath, "utf8"));
} catch {
  console.error(
    `gen:env: ${outputsPath} を読めません。先に infra/ で次を実行してください:\n` +
      "  npx cdk deploy --all --outputs-file cdk-outputs.json",
  );
  exit(2);
}

const { content, missing } = buildEnvFile(outputs, { vulnMode });

if (missing.length > 0) {
  console.error(
    `gen:env: ${outputsPath} に次の出力がありません: ${missing.join(", ")}\n` +
      "全スタックをデプロイしてから再実行してください(cdk deploy --all)。",
  );
  exit(1);
}

writeFileSync(path.resolve(TARGET), content, "utf8");
console.log(`gen:env: ${TARGET} を生成しました (vulnMode=${vulnMode})`);
if (vulnMode) {
  console.warn(
    "警告: 検証用の DOM-XSS ページを含むビルドになります。実験 E8 以外では使わないでください。",
  );
}
