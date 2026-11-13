import { useLabAuth } from "../auth/useLabAuth";

/** ID トークンのクレーム表示(SPEC 4.6) */
export function Profile() {
  const auth = useLabAuth();

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold">Profile</h1>
      <p className="text-sm leading-6">ID トークンのクレームを表示します。</p>
      <pre className="overflow-x-auto rounded border border-slate-200 bg-white p-4 text-xs">
        {JSON.stringify(auth.claims ?? {}, null, 2)}
      </pre>
    </section>
  );
}
