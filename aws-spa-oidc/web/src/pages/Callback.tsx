import { useLabAuth } from "../auth/useLabAuth";

/**
 * Cognito からのリダイレクト先。
 * トークン交換は react-oidc-context が担い、完了後に `/` へ URL を戻す。
 */
export function Callback() {
  const auth = useLabAuth();

  if (auth.error) {
    return (
      <p className="rounded border border-red-300 bg-red-50 p-4 text-sm">
        ログインに失敗しました: {auth.error}
      </p>
    );
  }

  return <p className="text-sm text-slate-500">ログイン処理中…</p>;
}
