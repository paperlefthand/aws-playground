/* ==========================================================================
 *
 *   検証専用。本番配布禁止。
 *
 *   このファイルは **意図的に DOM-XSS 脆弱性を含む**(実験 E8 用)。
 *   URL クエリ `?q=` の値を無害化せずに `dangerouslySetInnerHTML` へ渡し、
 *   CSP がある場合と無い場合で「外部ドメインへの情報送信が成立するか」を
 *   比較するための的として使う。
 *
 *   `VITE_VULN_MODE=true` でビルドしたときだけルーティングに入る。
 *   false のときはバンドルに含まれないことを test/vuln-mode.test.ts で検証している。
 *
 * ========================================================================== */

import { useSearchParams } from "react-router-dom";

/** バンドルへの混入検査に使う目印。他の文字列と衝突しない値にすること */
export const VULN_MODE_BUNDLE_MARKER = "lab-vulnerable-search-do-not-ship";

export function VulnerableSearch() {
  const [searchParams] = useSearchParams();
  const query = searchParams.get("q") ?? "";

  return (
    <section className="space-y-4" data-lab-marker={VULN_MODE_BUNDLE_MARKER}>
      <h1 className="text-2xl font-bold text-red-700">Vulnerable Search(検証専用)</h1>
      <p className="text-sm leading-6">
        <code>?q=</code> の値をそのまま HTML として描画します。実験 E8 でペイロードを注入し、CSP
        の有無で挙動を比較します。
      </p>
      <div className="rounded border border-red-300 bg-red-50 p-4">
        {/* biome-ignore lint: 意図的な DOM-XSS シンク(実験 E8 用) */}
        {/* eslint-disable-next-line react/no-danger -- 意図的な DOM-XSS シンク */}
        <div dangerouslySetInnerHTML={{ __html: query }} />
      </div>
    </section>
  );
}
