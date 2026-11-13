import { describe, expect, it } from "vite-plus/test";
import { containsMarker, findForbiddenRuntimeApis } from "./check-bundle.mjs";
import { VULN_MODE_BUNDLE_MARKER } from "../src/lab/VulnerableSearch";

describe("findForbiddenRuntimeApis", () => {
  it.each([
    ["eval(", "var x = eval(payload);", "eval()"],
    ["new Function(", "const f = new Function('return 1');", "new Function()"],
  ])("%s を検出する", (_label, js, name) => {
    const findings = findForbiddenRuntimeApis(js);
    expect(findings.map((finding) => finding.name)).toContain(name);
  });

  // 識別子の一部やプロパティ名で誤検出しないこと(ミニファイ済みバンドルで頻出)
  it.each([
    "const retrieval = (x) => x;",
    "obj.eval(1);",
    "const x = { eval: 1 };",
    "somethingEval(2);",
    "new FunctionLike();",
  ])("誤検出しない: %s", (js) => {
    expect(findForbiddenRuntimeApis(js)).toEqual([]);
  });

  it("件数と前後の抜粋を返す", () => {
    const [finding] = findForbiddenRuntimeApis("a; eval(1); b; eval(2);");
    expect(finding.count).toBe(2);
    expect(finding.sample).toContain("eval(");
  });
});

describe("containsMarker", () => {
  // 目印がずれると検査が常に成功してしまうため、実体と突き合わせる
  it("検証用ページの目印が定数と一致している", () => {
    expect(VULN_MODE_BUNDLE_MARKER).toBe("lab-vulnerable-search-do-not-ship");
    expect(containsMarker(`x="${VULN_MODE_BUNDLE_MARKER}"`, VULN_MODE_BUNDLE_MARKER)).toBe(true);
    expect(containsMarker("no marker here", VULN_MODE_BUNDLE_MARKER)).toBe(false);
  });
});
