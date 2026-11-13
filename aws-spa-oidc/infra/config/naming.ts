/**
 * スタックをまたいで参照される「決定的なリソース名」の単一情報源。
 *
 * なぜ名前を固定するのか:
 * WAF ログバケットは WafEdgeStack(us-east-1)/ WafCognitoStack が作るが、それを
 * 読む Glue テーブルは CoreStack(ap-northeast-1)にある(SPEC 2 のアーキテクチャ図)。
 * CloudFormation のクロススタック参照は使えない(リージョンをまたぐ上に循環する)ため、
 * **名前の一致**で解決する。名前がずれると静かに壊れるので必ずここを経由すること。
 * (docs/OPEN_QUESTIONS.md Q5)
 *
 * WAF が書き出すオブジェクトキーに現れるリージョンは **WebACL のリージョン**であって
 * バケットのリージョンではない。CLOUDFRONT スコープの WebACL は us-east-1 固定なので、
 * バケットをどこに置いてもパスは `.../WAFLogs/us-east-1/...` になる。
 */

/** WAF の S3 ログ配信先バケットは `aws-waf-logs-` 始まり・WebACL と同一アカウントが必須 */
const WAF_LOG_BUCKET_PREFIX = "aws-waf-logs-";

export const EDGE_REGION = "us-east-1";

export function edgeWafLogBucketName(namePrefix: string, account: string): string {
  return `${WAF_LOG_BUCKET_PREFIX}${namePrefix}-edge-${account}`;
}

export function cognitoWafLogBucketName(
  namePrefix: string,
  account: string,
  region: string,
): string {
  return `${WAF_LOG_BUCKET_PREFIX}${namePrefix}-cognito-${account}-${region}`;
}

export function edgeWebAclName(namePrefix: string): string {
  return `${namePrefix}-edge`;
}

export function cognitoWebAclName(namePrefix: string): string {
  return `${namePrefix}-cognito`;
}

/**
 * WAF が S3 に書き出すオブジェクトキーの階層。
 * `AWSLogs/<account>/WAFLogs/<region>/<webacl>/<yyyy>/<MM>/<dd>/<HH>/<mm>/`
 */
export function wafLogS3Prefix(account: string, region: string, webAclName: string): string {
  return `AWSLogs/${account}/WAFLogs/${region}/${webAclName}`;
}

/**
 * CloudFront → CSP コレクタの共有シークレット。
 *
 * CloudFront の Origin Custom Header は文字列しか受け付けず、値は CoreStack の
 * Lambda(期待値)と DeliveryStack の CloudFront(送信値)の両方で必要になる。
 * ARN をクロススタック参照すると `{{resolve:...}}` の中に `Fn::ImportValue` が
 * 入ってしまい動的参照として解釈されないため、**シークレット名を指定して作成し、
 * 両スタックが名前からリテラルな動的参照文字列を組み立てる**。
 * こうするとテンプレートに載るのは参照だけで、値そのものは載らない(SPEC 6)。
 */
export function originSecretName(namePrefix: string): string {
  return `${namePrefix}/cloudfront-origin-secret`;
}

export function originSecretDynamicRef(namePrefix: string): string {
  return `{{resolve:secretsmanager:${originSecretName(namePrefix)}:SecretString:::}}`;
}

/** CloudFront が付与し、CSP コレクタが検証するヘッダ名 */
export const ORIGIN_SECRET_HEADER = "x-lab-origin-secret";

export function edgeWafLogLocation(namePrefix: string, account: string): string {
  const bucket = edgeWafLogBucketName(namePrefix, account);
  const prefix = wafLogS3Prefix(account, EDGE_REGION, edgeWebAclName(namePrefix));
  return `s3://${bucket}/${prefix}/`;
}

export function cognitoWafLogLocation(namePrefix: string, account: string, region: string): string {
  const bucket = cognitoWafLogBucketName(namePrefix, account, region);
  const prefix = wafLogS3Prefix(account, region, cognitoWebAclName(namePrefix));
  return `s3://${bucket}/${prefix}/`;
}
