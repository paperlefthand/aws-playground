/**
 * WAF ルール定義の単一情報源(SPEC 4.4 / 4.5)。
 *
 * ここで定義した `name` はそのまま CloudWatch メトリクス名になり、
 * レポートの表・Athena クエリの `terminatingruleid` と一致する。名前を変えると
 * 過去の測定結果と接続できなくなるので、変更時は experiments/results 側の
 * 集計スクリプトも合わせて見直すこと。
 *
 * ルールグループ内の個別ルールを除外(exclude)する場合は、
 * **必ず理由と根拠となる観測日時をコメントに書く**(SPEC 4.4)。
 */

export interface ManagedRuleGroupSpec {
  readonly priority: number;
  /** WebACL 内のルール名 = CloudWatch メトリクス名 */
  readonly name: string;
  readonly vendorName: string;
  readonly managedRuleGroupName: string;
  /**
   * true のとき `wafAction` の値によらず常に Count。
   * 誤検知分析(E4)の素材として観測だけ続けたいルールに使う。
   */
  readonly alwaysCount: boolean;
  /** alwaysCount の理由。レポートにそのまま引用する */
  readonly note?: string;
  /**
   * 除外するルール名。空でないときは必ず理由と観測日時を note に書くこと。
   * (現時点では観測前なので全て空。E4 の結果に基づいて追加する)
   */
  readonly excludedRules: readonly string[];
}

export const EDGE_MANAGED_RULE_GROUPS: readonly ManagedRuleGroupSpec[] = [
  {
    priority: 10,
    name: "AWSManagedRulesAmazonIpReputationList",
    vendorName: "AWS",
    managedRuleGroupName: "AWSManagedRulesAmazonIpReputationList",
    alwaysCount: false,
    excludedRules: [],
  },
  {
    priority: 20,
    name: "AWSManagedRulesAnonymousIpList",
    vendorName: "AWS",
    managedRuleGroupName: "AWSManagedRulesAnonymousIpList",
    alwaysCount: true,
    note: "VPN/Tor 利用者の誤検知が出やすく、FP 分析(E4)の主要素材になるため常に Count",
    excludedRules: [],
  },
  {
    priority: 30,
    name: "AWSManagedRulesCommonRuleSet",
    vendorName: "AWS",
    managedRuleGroupName: "AWSManagedRulesCommonRuleSet",
    alwaysCount: false,
    excludedRules: [],
  },
  {
    priority: 40,
    name: "AWSManagedRulesKnownBadInputsRuleSet",
    vendorName: "AWS",
    managedRuleGroupName: "AWSManagedRulesKnownBadInputsRuleSet",
    alwaysCount: false,
    excludedRules: [],
  },
  {
    priority: 50,
    name: "AWSManagedRulesSQLiRuleSet",
    vendorName: "AWS",
    managedRuleGroupName: "AWSManagedRulesSQLiRuleSet",
    alwaysCount: true,
    note: "静的 SPA には SQL 送信経路が無く FP のみが観測されるはずなので Count 開始",
    excludedRules: [],
  },
];

/** レートベースルールの評価窓(秒)。AWS WAF の既定は 300 秒 = 5 分 */
export const RATE_LIMIT_WINDOW_SECONDS = 300;

export const RATE_RULE_ALL = {
  priority: 100,
  name: "RateLimitAllPaths",
} as const;

export const RATE_RULE_API = {
  priority: 110,
  name: "RateLimitApiPaths",
  /** SPEC 4.2 の /api/* ビヘイビアと一致させること */
  pathPrefix: "/api/",
} as const;

export const GEO_MATCH_RULE = {
  priority: 200,
  name: "GeoMatchVisibility",
  note: "国別可視化のみが目的。ブロックはしない(常に Count)",
  /**
   * 可視化のため「日本以外」を Count する。国を絞ることでメトリクスが
   * 「想定外の国からのアクセス」を直接表すようになる。
   */
  countryCodes: ["JP"] as const,
} as const;

export const COGNITO_RATE_RULE = {
  priority: 10,
  name: "CognitoRateLimit",
} as const;

/**
 * WAF ログから伏せるヘッダ(SPEC 4.4)。
 * WAF の redactedFields はヘッダ名を小文字で指定する。
 */
export const REDACTED_LOG_HEADERS: readonly string[] = ["authorization", "cookie"];

/** ブロック時に返すカスタムレスポンス。計測可能性のため 403 + JSON + 識別ヘッダ */
export const BLOCK_RESPONSE = {
  statusCode: 403,
  contentType: "application/json",
  /** E4 で「WAF による 403」と「オリジン由来の 403」を切り分けるための印 */
  markerHeaderName: "x-lab-blocked-by",
  markerHeaderValue: "waf",
  body: JSON.stringify({ message: "Request blocked by AWS WAF", lab: true }),
  /** CfnWebACL.customResponseBodies のキー */
  bodyKey: "labBlocked",
} as const;
