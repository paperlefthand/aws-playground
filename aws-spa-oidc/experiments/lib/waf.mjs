/**
 * WAF のブロックを応答から判定する。
 *
 * SPEC 4.2 の要点: CloudFront のカスタムエラーレスポンスを使っていないので、
 * WAF による 403 は 403 のまま観測できる。オリジン由来の 403 と切り分けるため、
 * WebACL 側で識別用のカスタムヘッダを付けている。
 *
 * **`infra/config/waf-rules.ts` の BLOCK_RESPONSE と一致させること。**
 * ここがずれると、ブロックされているのに「ブロックされていない」と誤判定する。
 */

export const BLOCK_MARKER_HEADER = "x-lab-blocked-by";
export const BLOCK_MARKER_VALUE = "waf";
export const BLOCK_STATUS = 403;

/**
 * @param {{ status: number, headers: Record<string, string> }} result
 */
export function isWafBlock(result) {
  const marker = findHeader(result.headers, BLOCK_MARKER_HEADER);
  return result.status === BLOCK_STATUS && marker === BLOCK_MARKER_VALUE;
}

/**
 * 403 ではあるが WAF の印が無いもの。オリジン由来か、Managed Login のように
 * カスタムヘッダが載らない経路の可能性がある。取りこぼしを可視化するために分ける。
 */
export function isUnmarkedForbidden(result) {
  return result.status === BLOCK_STATUS && !isWafBlock(result);
}

/** ヘッダ名の大文字小文字を無視して引く */
export function findHeader(headers, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}
