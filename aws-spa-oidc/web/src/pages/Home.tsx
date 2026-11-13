export function Home() {
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold">エッジ多層防御 実験環境</h1>
      <p className="text-sm leading-6">
        CloudFront + S3 + Cognito 上の React SPA に対する WAF / セキュリティヘッダ / CSP
        の効果を定量測定するためのラボです。 hardened / baseline の 2
        ディストリビューション比較で計測します。
      </p>
      <p className="text-sm text-slate-500">
        認証(Cognito Managed Login)の結線は Phase 4 で実装されます。
      </p>
    </section>
  );
}
