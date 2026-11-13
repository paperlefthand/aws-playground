import type { ReactNode } from "react";
import { useLabAuth } from "./useLabAuth";

/** 認証必須ページのガード(SPEC 4.6) */
export function RequireAuth({ children }: { children: ReactNode }) {
  const auth = useLabAuth();

  if (!auth.configured) {
    return (
      <p className="rounded border border-amber-300 bg-amber-50 p-4 text-sm">
        Cognito の設定がありません。<code>vp run gen:env</code> で<code>web/.env.local</code>{" "}
        を生成してください(README 参照)。
      </p>
    );
  }

  if (auth.isLoading) {
    return <p className="text-sm text-slate-500">認証状態を確認しています…</p>;
  }

  if (auth.error) {
    return (
      <p className="rounded border border-red-300 bg-red-50 p-4 text-sm">
        認証エラー: {auth.error}
      </p>
    );
  }

  if (!auth.isAuthenticated) {
    return (
      <div className="space-y-4">
        <p className="text-sm">このページを見るにはログインが必要です。</p>
        <button
          type="button"
          onClick={auth.signIn}
          className="rounded bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800"
        >
          Cognito でログイン
        </button>
      </div>
    );
  }

  return <>{children}</>;
}
