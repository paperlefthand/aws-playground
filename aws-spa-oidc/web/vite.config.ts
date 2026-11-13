import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    modulePreload: {
      // SPEC 4.3: polyfill は index.html に inline script を注入するため無効化。
      // 無効化の結果は `vp run verify:no-inline` で検査する。
      polyfill: false,
    },
  },
});
