import { describe, expect, it } from "vite-plus/test";
import { CALLBACK_PATH, buildLogoutUrl, buildOidcConfig, readCognitoEnv } from "./config";

const env = {
  userPoolId: "ap-northeast-1_AbCdEfGh",
  clientId: "1example23456789",
  domain: "edge-lab-123456789012.auth.ap-northeast-1.amazoncognito.com",
  region: "ap-northeast-1",
};

describe("readCognitoEnv", () => {
  it("必要な値が揃っていれば読み取る", () => {
    expect(
      readCognitoEnv({
        VITE_COGNITO_USER_POOL_ID: env.userPoolId,
        VITE_COGNITO_CLIENT_ID: env.clientId,
        VITE_COGNITO_DOMAIN: env.domain,
        VITE_COGNITO_REGION: env.region,
      } as ImportMetaEnv),
    ).toEqual(env);
  });

  // .env.local を生成していない状態でも画面が壊れないようにするため
  it.each([
    "VITE_COGNITO_USER_POOL_ID",
    "VITE_COGNITO_CLIENT_ID",
    "VITE_COGNITO_DOMAIN",
    "VITE_COGNITO_REGION",
  ])("%s が無ければ undefined", (missing) => {
    const values: Record<string, string> = {
      VITE_COGNITO_USER_POOL_ID: env.userPoolId,
      VITE_COGNITO_CLIENT_ID: env.clientId,
      VITE_COGNITO_DOMAIN: env.domain,
      VITE_COGNITO_REGION: env.region,
    };
    delete values[missing];
    expect(readCognitoEnv(values as ImportMetaEnv)).toBeUndefined();
  });
});

describe("buildOidcConfig", () => {
  // SPEC 4.1: Authorization Code のみ。暗黙フローは使わない
  it("Authorization Code フローを使う", () => {
    const config = buildOidcConfig(env, "https://d111.cloudfront.net");
    expect(config.response_type).toBe("code");
    expect(config.scope).toBe("openid email profile");
  });

  it("authority が Cognito のユーザープールを指す", () => {
    const config = buildOidcConfig(env, "https://d111.cloudfront.net");
    expect(config.authority).toBe(
      "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_AbCdEfGh",
    );
  });

  // hardened と baseline は同一バンドルを配信する(SPEC 2.1)。
  // redirect_uri を焼き込むと baseline で開いても hardened に戻され比較にならない。
  it("redirect_uri を実行時のオリジンから組み立てる", () => {
    expect(buildOidcConfig(env, "https://d111.cloudfront.net").redirect_uri).toBe(
      `https://d111.cloudfront.net${CALLBACK_PATH}`,
    );
    expect(buildOidcConfig(env, "https://d222.cloudfront.net").redirect_uri).toBe(
      `https://d222.cloudfront.net${CALLBACK_PATH}`,
    );
  });

  // 自動更新のネットワーク往復が E7 のレイテンシ測定に混ざらないようにする
  it("サイレント更新を使わない", () => {
    expect(buildOidcConfig(env, "https://d111.cloudfront.net").automaticSilentRenew).toBe(false);
  });
});

describe("buildLogoutUrl", () => {
  // Cognito のログアウトは OIDC 標準ではなく独自エンドポイント
  it("Cognito のドメインの /logout を client_id と logout_uri 付きで指す", () => {
    const url = new URL(buildLogoutUrl(env, "https://d111.cloudfront.net"));
    expect(url.origin).toBe(`https://${env.domain}`);
    expect(url.pathname).toBe("/logout");
    expect(url.searchParams.get("client_id")).toBe(env.clientId);
    // App Client の logoutUrls に登録した値と完全一致する必要がある
    expect(url.searchParams.get("logout_uri")).toBe("https://d111.cloudfront.net");
  });
});
