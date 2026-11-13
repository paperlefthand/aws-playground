import { defineConfig } from "vite-plus";

export default defineConfig({
  defaultPackage: "./web",
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
    overrides: [
      {
        files: ["web/**"],
        plugins: ["react"],
      },
      {
        files: ["**/*.test.ts", "**/*.test.tsx"],
        plugins: ["vitest"],
        rules: {
          // cdk assertions の Template.has*/resourceCountIs は一致しなければ
          // 自ら throw する。expect を経由しないだけで検証はしている。
          "vitest/expect-expect": ["warn", { assertFunctionNames: ["expect", "template.**"] }],
        },
      },
      {
        files: ["infra/**", "experiments/**", "web/scripts/**"],
        env: { node: true },
      },
    ],
  },
  test: {
    include: ["web/**/*.test.{ts,tsx}", "infra/test/**/*.test.ts", "experiments/**/*.test.ts"],
    // CDK の synth は 1 回あたり 1〜2 秒かかり、テストファイルが並列に走ると
    // さらに伸びる。既定の 5 秒では CDK assertions のテストが落ちる。
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  run: {
    tasks: {
      // CDK の出力から web/.env.local を生成する(SPEC 4.6: 値を手書きさせない)
      "gen:env": {
        command: "node web/scripts/gen-env.mjs",
        cache: false,
      },
      // SPEC 1 の禁止事項: eval / new Function を使うライブラリを混入させない
      "verify:bundle": {
        command: "node web/scripts/verify-bundle.mjs web/dist",
        cache: false,
      },
      // SPEC 4.6: vulnMode=false のビルドに検証用ページが含まれないこと
      "verify:vuln-mode": {
        command: "node web/scripts/verify-vuln-mode.mjs",
        cache: false,
      },
      // SPEC 4.3: ビルド後の dist/index.html に inline <script>/<style> が
      // 無いこと(CSP script-src 'self' の前提)を検査する
      "verify:no-inline": {
        command: "node web/scripts/verify-no-inline.mjs web/dist/index.html",
        cache: false,
      },
    },
  },
});
