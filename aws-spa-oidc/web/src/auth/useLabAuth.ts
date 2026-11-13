/**
 * 画面から使う認証状態の窓口。
 *
 * `.env.local` が無い(= まだデプロイしていない)ときも画面が壊れないよう、
 * react-oidc-context の有無をここで吸収する。
 */

import { useAuth } from "react-oidc-context";
import { cognitoEnv } from "./AuthProvider";
import { buildLogoutUrl } from "./config";

export interface LabAuth {
  readonly configured: boolean;
  readonly isLoading: boolean;
  readonly isAuthenticated: boolean;
  readonly error?: string;
  readonly claims?: Record<string, unknown>;
  // メソッド記法だと `this` を失う参照として扱われるため関数プロパティで持つ
  readonly signIn: () => void;
  readonly signOut: () => void;
}

export function useLabAuth(): LabAuth {
  // AuthProvider が無い場合 useAuth は undefined を返す
  const auth = useAuth();

  // クロージャの中では module スコープの cognitoEnv が narrow されないため束縛する
  const env = cognitoEnv;

  if (!env || !auth) {
    return {
      configured: false,
      isLoading: false,
      isAuthenticated: false,
      signIn: () => {},
      signOut: () => {},
    };
  }

  return {
    configured: true,
    isLoading: auth.isLoading,
    isAuthenticated: auth.isAuthenticated,
    error: auth.error?.message,
    claims: auth.user?.profile as Record<string, unknown> | undefined,
    signIn: () => void auth.signinRedirect(),
    signOut: () => {
      // Cognito のログアウトは独自エンドポイント。ローカルのセッションを消してから飛ぶ。
      void auth.removeUser().then(() => {
        window.location.assign(buildLogoutUrl(env, window.location.origin));
      });
    },
  };
}
