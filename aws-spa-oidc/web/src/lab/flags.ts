/**
 * ビルド時フラグ。
 *
 * `import.meta.env.VITE_*` はビルド時にリテラルへ置換されるため、
 * `VULN_MODE` は `"false" === "true"` のような定数式に畳み込まれ、
 * false のときは参照ごとバンドルから消える(tree-shaking)。
 * この性質に依存しているので、実行時に値を差し替える書き方に変えないこと。
 */

export const VULN_MODE = import.meta.env.VITE_VULN_MODE === "true";
