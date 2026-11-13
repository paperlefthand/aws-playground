export function Protected() {
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold">Protected</h1>
      <p className="text-sm leading-6">
        認証済みのユーザーだけが見られるページです。Cognito Managed Login (Authorization Code +
        PKCE)でログインしています。
      </p>
    </section>
  );
}
