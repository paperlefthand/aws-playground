/**
 * Cognito Managed Login(Authorization Code + PKCE)の設定。
 *
 * 値は `vp run gen:env` が CDK の出力から生成する `web/.env.local` から来る。
 * **手書きしないこと**(SPEC 4.6)。
 *
 * `redirect_uri` だけはビルド時に固定せず実行時に組み立てる。hardened と
 * baseline の 2 つのディストリビューションが **同一の S3 バケットにある同一の
 * バンドル** を配信するため(SPEC 2.1)、値を焼き込むと baseline で開いても
 * hardened に戻されてしまい、比較にならない。
 */

import type { UserManagerSettings } from "oidc-client-ts";

export interface CognitoEnv {
  readonly userPoolId: string;
  readonly clientId: string;
  /** 例: edge-lab-123456789012.auth.ap-northeast-1.amazoncognito.com */
  readonly domain: string;
  readonly region: string;
}

export const CALLBACK_PATH = "/callback";

export function readCognitoEnv(env: ImportMetaEnv): CognitoEnv | undefined {
  const userPoolId = env.VITE_COGNITO_USER_POOL_ID;
  const clientId = env.VITE_COGNITO_CLIENT_ID;
  const domain = env.VITE_COGNITO_DOMAIN;
  const region = env.VITE_COGNITO_REGION;

  if (!userPoolId || !clientId || !domain || !region) {
    return undefined;
  }
  return { userPoolId, clientId, domain, region };
}

export function buildOidcConfig(env: CognitoEnv, origin: string): UserManagerSettings {
  return {
    authority: `https://cognito-idp.${env.region}.amazonaws.com/${env.userPoolId}`,
    client_id: env.clientId,
    redirect_uri: `${origin}${CALLBACK_PATH}`,
    post_logout_redirect_uri: origin,
    response_type: "code",
    scope: "openid email profile",
    // トークンは sessionStorage(oidc-client-ts の既定)に置く。
    // 自動更新は使わない。更新の挙動が実験のレイテンシ測定に混ざるため。
    automaticSilentRenew: false,
  };
}

/**
 * Cognito のログアウトは OIDC の RP-Initiated Logout ではなく独自エンドポイント。
 * `logout_uri` は App Client の logoutUrls に登録済みのものと完全一致する必要がある。
 */
export function buildLogoutUrl(env: CognitoEnv, origin: string): string {
  const params = new URLSearchParams({ client_id: env.clientId, logout_uri: origin });
  return `https://${env.domain}/logout?${params.toString()}`;
}
