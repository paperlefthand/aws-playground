/// <reference types="vite/client" />

/**
 * `web/.env.local` の内容。生成は `vp run gen:env`(CDK の出力から)。
 * 手書きしないこと(SPEC 4.6)。
 */
interface ImportMetaEnv {
  readonly VITE_COGNITO_USER_POOL_ID?: string;
  readonly VITE_COGNITO_CLIENT_ID?: string;
  readonly VITE_COGNITO_DOMAIN?: string;
  readonly VITE_COGNITO_REGION?: string;
  /** "true" のときだけ検証用の脆弱ページをバンドルに含める(実験 E8) */
  readonly VITE_VULN_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
