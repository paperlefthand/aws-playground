import { describe, expect, it } from "vite-plus/test";
import { findInlineViolations } from "./check-no-inline.mjs";

const clean = `<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="/assets/index-abc123.css" />
    <script type="module" src="/assets/index-abc123.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>`;

describe("findInlineViolations", () => {
  it("外部参照のみの HTML を通す", () => {
    expect(findInlineViolations(clean)).toEqual([]);
  });

  it("inline <script> を検出する", () => {
    const html = clean.replace("</body>", "<script>window.__x = 1;</script></body>");
    const violations = findInlineViolations(html);
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("inline-script");
  });

  it("inline <style> を検出する", () => {
    const html = clean.replace("</head>", "<style>body { margin: 0 }</style></head>");
    const violations = findInlineViolations(html);
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("inline-style");
  });

  it("src 付き <script> の空ボディは許容する", () => {
    expect(findInlineViolations(clean)).toEqual([]);
  });

  it("複数の違反を全件報告する", () => {
    const html = clean
      .replace("</head>", "<style>.a{}</style></head>")
      .replace("</body>", "<script>1</script><script>2</script></body>");
    expect(findInlineViolations(html)).toHaveLength(3);
  });
});
