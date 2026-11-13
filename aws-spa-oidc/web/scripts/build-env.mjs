/**
 * CDK の出力から `web/.env.local` の内容を組み立てる純粋関数。
 * `vp run gen:env` と Vitest の両方から使う。
 *
 * 入力は `cdk deploy --all --outputs-file <path>` が出す JSON:
 *   { "<スタック名>": { "<出力名>": "<値>", ... }, ... }
 *
 * スタック名は `namePrefix` で変わるため、スタック名ではなく **出力名** で探す。
 */

/** 必要な CDK 出力名 → .env のキー */
export const OUTPUT_TO_ENV = {
  UserPoolId: "VITE_COGNITO_USER_POOL_ID",
  UserPoolClientId: "VITE_COGNITO_CLIENT_ID",
  UserPoolDomain: "VITE_COGNITO_DOMAIN",
  Region: "VITE_COGNITO_REGION",
};

/**
 * 出力名でスタックを横断して値を引く。同じ名前が複数あれば最初のものを使う。
 * @param {Record<string, Record<string, string>>} outputs
 * @param {string} name
 */
export function findOutput(outputs, name) {
  for (const stackOutputs of Object.values(outputs ?? {})) {
    const value = stackOutputs?.[name];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return undefined;
}

/**
 * @param {Record<string, Record<string, string>>} outputs
 * @param {{ vulnMode?: boolean }} [options]
 * @returns {{ content: string, missing: string[] }}
 */
export function buildEnvFile(outputs, options = {}) {
  const lines = [
    "# 自動生成: `vp run gen:env`(CDK の出力から)。手で編集しないこと。",
    "# 再生成するには: cdk deploy --all --outputs-file cdk-outputs.json",
    "",
  ];
  const missing = [];

  for (const [outputName, envKey] of Object.entries(OUTPUT_TO_ENV)) {
    const value = findOutput(outputs, outputName);
    if (value === undefined) {
      missing.push(outputName);
      continue;
    }
    lines.push(`${envKey}=${value}`);
  }

  // 実験 E8 用。既定は false(検証用ページを配布しない)
  lines.push(`VITE_VULN_MODE=${options.vulnMode === true ? "true" : "false"}`);
  lines.push("");

  return { content: lines.join("\n"), missing };
}
