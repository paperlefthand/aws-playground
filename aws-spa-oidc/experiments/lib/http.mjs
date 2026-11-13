/**
 * 実験用の HTTP クライアント。
 *
 * ホワイトリスト検査を必ず通すため、`fetch` を直接呼ばずこの関数を使うこと
 * (SPEC 4.7 の安全弁)。
 */

import { assertAllowedTarget } from "./targets.mjs";
import { BLOCK_MARKER_HEADER } from "./waf.mjs";

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * @param {string} url
 * @param {{ allowedHosts: Set<string>, method?: string, headers?: Record<string,string>,
 *           body?: string, timeoutMs?: number, redirect?: RequestRedirect }} options
 */
export async function labFetch(url, options) {
  assertAllowedTarget(url, options.allowedHosts);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const startedAt = performance.now();

  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      // リダイレクトを追うと計測対象のレスポンスが変わるので既定では追わない
      redirect: options.redirect ?? "manual",
      signal: controller.signal,
    });
    return {
      url,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      elapsedMs: Math.round(performance.now() - startedAt),
      blockedByWaf: response.headers.get(BLOCK_MARKER_HEADER) !== null,
      response,
    };
  } finally {
    clearTimeout(timer);
  }
}
