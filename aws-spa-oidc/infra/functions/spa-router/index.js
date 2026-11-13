/**
 * CloudFront Function(viewer-request)— SPA のパス書き換え(SPEC 4.2)。
 *
 * **カスタムエラーレスポンス(403 → /index.html を 200 で返す)は使わない。**
 * WAF による block も 403 として現れるため、カスタムエラーレスポンスを使うと
 * 「ブロックされた」事実が 200 の index.html にすり替わって観測できなくなる。
 * 代わりにここで書き換えることで、403 は 403 のまま残る。
 *
 * 注意:
 * - CloudFront Functions のランタイムは ES5.1 相当。`String#endsWith` などの
 *   ES6 メソッドは使わない。
 * - レスポンスボディは書き換えられない。HTML への nonce 注入が必要になったら
 *   Lambda@Edge が要る(今回は注入しない / docs/DECISIONS.md)。
 * - この関数は default behavior にだけ関連付ける。`/api/*` は別ビヘイビアなので
 *   ここを通らない。
 */

// eslint-disable-next-line no-unused-vars -- CloudFront Functions のエントリポイント
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // ディレクトリ指定は index.html を返す
  if (uri.charAt(uri.length - 1) === "/") {
    request.uri = uri + "index.html";
    return request;
  }

  // 最終セグメントに拡張子が無ければ SPA のルート → index.html に書き換える。
  // ハッシュ付きアセット(/assets/index-abc123.js)はそのまま通す。
  var lastSlash = uri.lastIndexOf("/");
  var lastSegment = lastSlash === -1 ? uri : uri.substring(lastSlash + 1);
  if (lastSegment.indexOf(".") === -1) {
    request.uri = "/index.html";
  }

  return request;
}
