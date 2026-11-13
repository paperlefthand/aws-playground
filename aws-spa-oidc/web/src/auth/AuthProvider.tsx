/**
 * react-oidc-context の設定。
 *
 * `.env.local` が未生成のときは認証を無効化した状態でアプリを描画する。
 * デプロイ前でも `vp dev` で画面を確認でき、設定漏れが画面に明示される。
 */

import type { ReactNode } from "react";
import { AuthProvider as OidcAuthProvider } from "react-oidc-context";
import { CALLBACK_PATH, buildOidcConfig, readCognitoEnv } from "./config";

export const cognitoEnv = readCognitoEnv(import.meta.env);

/** 認証コールバック後、URL からクエリ(code / state)を消して見た目を戻す */
function onSigninCallback(): void {
  window.history.replaceState({}, document.title, "/");
}

export function AuthProvider({ children }: { children: ReactNode }) {
  if (!cognitoEnv) {
    return <>{children}</>;
  }

  return (
    <OidcAuthProvider
      {...buildOidcConfig(cognitoEnv, window.location.origin)}
      onSigninCallback={onSigninCallback}
    >
      {children}
    </OidcAuthProvider>
  );
}

export { CALLBACK_PATH };
