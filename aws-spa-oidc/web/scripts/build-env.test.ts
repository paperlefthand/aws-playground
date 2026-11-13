import { describe, expect, it } from "vite-plus/test";
import { OUTPUT_TO_ENV, buildEnvFile, findOutput } from "./build-env.mjs";

const outputs = {
  "edge-lab-core": {
    UserPoolId: "ap-northeast-1_AbCdEfGh",
    UserPoolDomain: "edge-lab-123456789012.auth.ap-northeast-1.amazoncognito.com",
    Region: "ap-northeast-1",
    SiteBucketName: "edge-lab-core-sitebucket-xyz",
  },
  "edge-lab-delivery": {
    UserPoolClientId: "1example23456789",
    HardenedUrl: "https://d111.cloudfront.net",
    BaselineUrl: "https://d222.cloudfront.net",
  },
};

describe("findOutput", () => {
  // スタック名は namePrefix で変わるので、出力名だけで引けること
  it("スタックを横断して出力名で引ける", () => {
    expect(findOutput(outputs, "UserPoolClientId")).toBe("1example23456789");
    expect(findOutput(outputs, "Region")).toBe("ap-northeast-1");
  });

  it("見つからなければ undefined", () => {
    expect(findOutput(outputs, "NotThere")).toBeUndefined();
    expect(findOutput({}, "UserPoolId")).toBeUndefined();
  });
});

describe("buildEnvFile", () => {
  it("必要な値をすべて書き出す", () => {
    const { content, missing } = buildEnvFile(outputs);
    expect(missing).toEqual([]);
    for (const envKey of Object.values(OUTPUT_TO_ENV)) {
      expect(content).toContain(`${envKey}=`);
    }
    expect(content).toContain("VITE_COGNITO_USER_POOL_ID=ap-northeast-1_AbCdEfGh");
    expect(content).toContain("VITE_COGNITO_CLIENT_ID=1example23456789");
  });

  // 検証用の脆弱ページを事故で配布しないための既定値
  it("vulnMode は既定で false", () => {
    expect(buildEnvFile(outputs).content).toContain("VITE_VULN_MODE=false");
    expect(buildEnvFile(outputs, { vulnMode: true }).content).toContain("VITE_VULN_MODE=true");
  });

  // 部分デプロイの状態で中途半端な .env.local を作らない
  it("足りない出力を報告する", () => {
    const { missing } = buildEnvFile({ "edge-lab-core": outputs["edge-lab-core"] });
    expect(missing).toEqual(["UserPoolClientId"]);
  });

  it("生成物であることが分かるヘッダを付ける", () => {
    expect(buildEnvFile(outputs).content).toContain("自動生成");
  });
});
