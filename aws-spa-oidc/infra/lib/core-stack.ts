/**
 * CoreStack(SPEC 4.1)— ap-northeast-1。
 *
 * hardened / baseline 両ディストリビューションが共有するオリジンと、
 * 実験の計測基盤(CSP レポート収集 API、WAF ログ分析用 Athena)を持つ。
 * CloudFront 自体は DeliveryStack(Phase 2)側で作る。
 */

import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as athena from "aws-cdk-lib/aws-athena";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as glue from "aws-cdk-lib/aws-glue";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import type { LabContext } from "../config/context.ts";
import { CSP_REPORT_PATH } from "../config/csp.ts";
import {
  EDGE_REGION,
  cognitoWafLogLocation,
  cognitoWebAclName,
  edgeWafLogLocation,
  edgeWebAclName,
  originSecretDynamicRef,
  originSecretName,
} from "../config/naming.ts";

/**
 * CSP コレクタがログを書ける範囲を表す ARN の「形」。
 *
 * IAM ポリシーに載せるときは CDK トークン(擬似パラメータ)を、cdk-nag の
 * acknowledge ID を組み立てるときは cdk-nag が出力するプレースホルダ文字列
 * (`<AWS::Partition>` など)を渡す。両者がずれないよう組み立てを 1 箇所に集約する。
 * (bin/nag-suppressions.ts 参照)
 */
export function cspCollectorLogStreamArn(parts: {
  readonly partition: string;
  readonly region: string;
  readonly account: string;
  readonly logGroupName: string;
}): string {
  return `arn:${parts.partition}:logs:${parts.region}:${parts.account}:log-group:${parts.logGroupName}:log-stream:*`;
}

/** CSP レポート API のスロットリング。違反レポートによる DoS 自体が論点(SPEC 4.1) */
export const CSP_API_THROTTLE_RATE = 20;
export const CSP_API_THROTTLE_BURST = 40;

/** WAF ログの Glue パーティション射影で走査する年の範囲 */
const WAF_LOG_PROJECTION_YEARS = { start: 2026, end: 2030 };

export interface CoreStackProps extends cdk.StackProps {
  readonly labContext: LabContext;
}

export class CoreStack extends cdk.Stack {
  /** SPA のビルド成果物を置くバケット。hardened / baseline が同じものを見る */
  public readonly siteBucket: s3.Bucket;
  /** S3 サーバアクセスログの配信先 */
  public readonly accessLogsBucket: s3.Bucket;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolDomain: cognito.UserPoolDomain;
  public readonly cspApi: apigwv2.HttpApi;
  public readonly cspCollector: lambda.Function;
  public readonly cspCollectorRole: iam.Role;
  public readonly cspCollectorLogs: logs.LogGroup;
  /** CloudFront が付与し、CSP コレクタが検証する共有シークレット */
  public readonly originSecret: secretsmanager.Secret;

  public constructor(scope: Construct, id: string, props: CoreStackProps) {
    super(scope, id, props);

    const { namePrefix } = props.labContext;

    this.accessLogsBucket = this.createAccessLogsBucket();
    this.siteBucket = this.createSiteBucket(this.accessLogsBucket);
    const { userPool, userPoolDomain } = this.createUserPool(namePrefix);
    this.userPool = userPool;
    this.userPoolDomain = userPoolDomain;

    const { api, collector, collectorRole, collectorLogs, originSecret } =
      this.createCspReportApi(namePrefix);
    this.cspApi = api;
    this.cspCollector = collector;
    this.cspCollectorRole = collectorRole;
    this.cspCollectorLogs = collectorLogs;
    this.originSecret = originSecret;

    this.createWafLogAnalysis(namePrefix, this.accessLogsBucket);
    this.createOutputs();
  }

  private createAccessLogsBucket(): s3.Bucket {
    return new s3.Bucket(this, "AccessLogsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      // S3 サーバアクセスログの配信は ACL ではなくバケットポリシーで受ける
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
  }

  private createSiteBucket(accessLogsBucket: s3.Bucket): s3.Bucket {
    const bucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: "s3-access/site/",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // OAC 経由の CloudFront にだけ読ませる。
    //
    // 本来は SourceArn に個別のディストリビューション ARN を書きたいが、それを
    // すると「CoreStack のバケットポリシー → DeliveryStack のディストリビュー
    // ション」と「DeliveryStack → CoreStack のバケット」で循環参照になる。
    // アカウント単位のワイルドカードに落とし、Block Public Access と
    // aws:SecureTransport で守る(docs/DECISIONS.md に記録)。
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowCloudFrontOacRead",
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
        actions: ["s3:GetObject"],
        resources: [bucket.arnForObjects("*")],
        conditions: {
          StringEquals: { "AWS:SourceAccount": this.account },
          ArnLike: {
            "AWS:SourceArn": `arn:${this.partition}:cloudfront::${this.account}:distribution/*`,
          },
        },
      }),
    );

    return bucket;
  }

  private createUserPool(namePrefix: string): {
    userPool: cognito.UserPool;
    userPoolDomain: cognito.UserPoolDomain;
  } {
    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `${namePrefix}-users`,
      // Managed Login を使う。WebACL の関連付けは全機能プランで可能なので
      // 追加課金の無い既定の Essentials を選ぶ(OPEN_QUESTIONS Q2)。
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      // 実験用ユーザーは管理者が作る。公開セルフサインアップは開けない。
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(1),
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true, email: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // ラボなので teardown を優先する(docs/TEARDOWN.md)
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
    });

    const userPoolDomain = userPool.addDomain("ManagedLoginDomain", {
      cognitoDomain: {
        // Cognito のドメイン接頭辞は全 AWS で一意である必要があるため
        // アカウント ID を混ぜる
        domainPrefix: `${namePrefix}-${this.account}`,
      },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    return { userPool, userPoolDomain };
  }

  private createCspReportApi(namePrefix: string): {
    api: apigwv2.HttpApi;
    collector: lambda.Function;
    collectorRole: iam.Role;
    collectorLogs: logs.LogGroup;
    originSecret: secretsmanager.Secret;
  } {
    // CloudFront が Origin Custom Header に載せる共有シークレット。
    // 値はデプロイ時に Secrets Manager が生成し、テンプレートには
    // 動的参照(`{{resolve:secretsmanager:...}}`)だけが載る = コードに秘密を
    // 埋め込まない(SPEC 6)。
    const originSecret = new secretsmanager.Secret(this, "OriginSecret", {
      // 名前を固定することで DeliveryStack 側がクロススタック参照なしに
      // リテラルな動的参照を組み立てられる(config/naming.ts 参照)
      secretName: originSecretName(namePrefix),
      description:
        "Shared value for the CloudFront origin custom header checked by the CSP collector",
      generateSecretString: {
        passwordLength: 40,
        excludePunctuation: true,
        includeSpace: false,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const collectorLogs = new logs.LogGroup(this, "CspCollectorLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // AWSLambdaBasicExecutionRole(AWS 管理ポリシー)は使わず、この関数専用の
    // ロググループにだけ書ける最小権限ロールを組む。管理ポリシーは対象リソースを
    // 絞れず cdk-nag AwsSolutions-IAM4 の指摘対象にもなるため。
    const collectorRole = new iam.Role(this, "CspCollectorRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Execution role for the CSP collector Lambda (own log group only)",
    });
    collectorRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        // ログストリーム名は実行ごとに変わるため、対象はこのロググループ配下に限定する。
        //
        // ここで `this.formatArn()`(= 具体値のアカウント/リージョンに解決される)を
        // 使わず擬似パラメータを直書きするのは、cdk-nag の granular finding ID に
        // この ARN 文字列がそのまま入るため。具体値だと認証情報の有無で ID が変わり、
        // acknowledge の文字列が環境ごとにずれる(bin/nag-suppressions.ts 参照)。
        resources: [
          cspCollectorLogStreamArn({
            partition: cdk.Aws.PARTITION,
            region: cdk.Aws.REGION,
            account: cdk.Aws.ACCOUNT_ID,
            logGroupName: collectorLogs.logGroupName,
          }),
        ],
      }),
    );

    const collector = new lambda.Function(this, "CspCollector", {
      role: collectorRole,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(
        path.join(import.meta.dirname, "..", "functions", "csp-collector"),
      ),
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,
      logGroup: collectorLogs,
      environment: {
        LAB_ORIGIN_SECRET: originSecretDynamicRef(namePrefix),
      },
    });

    // シークレット「名」による動的参照は **CloudFormation の依存グラフに現れない**。
    // 依存を明示しないと削除時にシークレットが先に消え、その後 Lambda を削除する際に
    // 動的参照が解決できず `ResourceNotFoundException` で DELETE_FAILED になる
    // (作成時はたまたま順序が合うため表面化しない)。
    // 依存を張ると削除は Lambda → シークレットの順になる。
    // この動的参照を新たに使う resource を足すときは、同じ依存を必ず張ること。
    collector.node.addDependency(originSecret);

    const api = new apigwv2.HttpApi(this, "CspReportApi", {
      apiName: `${namePrefix}-csp-report`,
      description: "CSP violation report collector (SPEC 4.1)",
      // CloudFront と同一オリジンにして CORS を回避する構成なので CORS は開けない
    });

    api.addRoutes({
      path: CSP_REPORT_PATH,
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "CspCollectorIntegration",
        collector,
      ),
    });

    const apiAccessLogs = new logs.LogGroup(this, "CspApiAccessLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const defaultStage = api.defaultStage?.node.defaultChild as apigwv2.CfnStage;
    defaultStage.defaultRouteSettings = {
      throttlingRateLimit: CSP_API_THROTTLE_RATE,
      throttlingBurstLimit: CSP_API_THROTTLE_BURST,
      detailedMetricsEnabled: true,
    };
    defaultStage.accessLogSettings = {
      destinationArn: apiAccessLogs.logGroupArn,
      format: JSON.stringify({
        requestId: "$context.requestId",
        ip: "$context.identity.sourceIp",
        requestTime: "$context.requestTime",
        routeKey: "$context.routeKey",
        status: "$context.status",
        integrationStatus: "$context.integrationStatus",
      }),
    };

    return { api, collector, collectorRole, collectorLogs, originSecret };
  }

  /**
   * WAF ログ分析基盤(SPEC 4.1 / 4.4)。
   *
   * Glue テーブルが指すのは WafEdgeStack(Phase 2)が作る WAF ログバケット。
   * リージョンをまたぐ上に循環するためクロススタック参照は使えず、
   * config/naming.ts の決定的な名前で解決する(docs/OPEN_QUESTIONS.md Q5)。
   * パス中のリージョンは WebACL のリージョン(CLOUDFRONT スコープなので us-east-1)。
   */
  private createWafLogAnalysis(namePrefix: string, accessLogsBucket: s3.Bucket): void {
    const resultsBucket = new s3.Bucket(this, "AthenaResultsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: "s3-access/athena-results/",
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new athena.CfnWorkGroup(this, "WafAnalysisWorkGroup", {
      name: `${namePrefix}-waf-analysis`,
      description: "False-positive analysis of AWS WAF logs (experiment E4)",
      state: "ENABLED",
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        resultConfiguration: {
          outputLocation: `s3://${resultsBucket.bucketName}/query-results/`,
          encryptionConfiguration: { encryptionOption: "SSE_S3" },
        },
      },
    });

    const databaseName = `${namePrefix.replaceAll("-", "_")}_waf_logs`;
    const database = new glue.CfnDatabase(this, "WafLogsDatabase", {
      catalogId: this.account,
      databaseInput: {
        name: databaseName,
        description: "AWS WAF logs (experiment E4)",
      },
    });

    // エッジ(CLOUDFRONT スコープ)と Cognito(REGIONAL スコープ)で
    // WebACL が別なのでログも別。テーブルを分けて E4 / E6 で使い分ける。
    this.createWafLogTable({
      id: "EdgeWafLogsTable",
      tableName: "edge_waf_logs",
      databaseName,
      database,
      location: edgeWafLogLocation(namePrefix, this.account),
      description: `Logs of the CLOUDFRONT-scope web ACL ${edgeWebAclName(namePrefix)} in ${EDGE_REGION}`,
    });
    this.createWafLogTable({
      id: "CognitoWafLogsTable",
      tableName: "cognito_waf_logs",
      databaseName,
      database,
      location: cognitoWafLogLocation(namePrefix, this.account, this.region),
      description: `Logs of the COGNITO_USER_POOL-scope web ACL ${cognitoWebAclName(namePrefix)} in ${this.region}`,
    });
  }

  /**
   * WAF ログ用の Glue テーブル。パーティション射影を使うので MSCK REPAIR が要らない
   * (実験手順を単純にするため)。
   */
  private createWafLogTable(options: {
    readonly id: string;
    readonly tableName: string;
    readonly databaseName: string;
    readonly database: glue.CfnDatabase;
    readonly location: string;
    readonly description: string;
  }): void {
    const table = new glue.CfnTable(this, options.id, {
      catalogId: this.account,
      databaseName: options.databaseName,
      tableInput: {
        name: options.tableName,
        description: options.description,
        tableType: "EXTERNAL_TABLE",
        parameters: {
          EXTERNAL: "TRUE",
          "projection.enabled": "true",
          "projection.year.type": "integer",
          "projection.year.range": `${WAF_LOG_PROJECTION_YEARS.start},${WAF_LOG_PROJECTION_YEARS.end}`,
          "projection.year.digits": "4",
          "projection.month.type": "integer",
          "projection.month.range": "1,12",
          "projection.month.digits": "2",
          "projection.day.type": "integer",
          "projection.day.range": "1,31",
          "projection.day.digits": "2",
          "projection.hour.type": "integer",
          "projection.hour.range": "0,23",
          "projection.hour.digits": "2",
          "storage.location.template": `${options.location}\${year}/\${month}/\${day}/\${hour}/`,
        },
        partitionKeys: [
          { name: "year", type: "string" },
          { name: "month", type: "string" },
          { name: "day", type: "string" },
          { name: "hour", type: "string" },
        ],
        storageDescriptor: {
          location: options.location,
          inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
          outputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
          serdeInfo: {
            serializationLibrary: "org.openx.data.jsonserde.JsonSerDe",
            parameters: { "ignore.malformed.json": "true" },
          },
          columns: WAF_LOG_COLUMNS.map((column) => ({
            name: column.name,
            type: column.type,
          })),
        },
      },
    });
    table.addResourceDependency(options.database);
  }

  private createOutputs(): void {
    new cdk.CfnOutput(this, "SiteBucketName", { value: this.siteBucket.bucketName });
    // web/.env.local の生成に使う(vp run gen:env)。
    // OIDC の authority を組み立てるのにリージョンが要る。
    new cdk.CfnOutput(this, "Region", { value: this.region });
    new cdk.CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolDomain", {
      value: `${this.userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com`,
    });
    new cdk.CfnOutput(this, "CspReportApiEndpoint", {
      value: this.cspApi.apiEndpoint,
    });
  }
}

/**
 * AWS WAF のログスキーマ(v1)。Athena の JSON SerDe で読むためのカラム定義。
 * WAF が出力するフィールド名はすべて小文字。
 */
export const WAF_LOG_COLUMNS: readonly { name: string; type: string }[] = [
  { name: "timestamp", type: "bigint" },
  { name: "formatversion", type: "int" },
  { name: "webaclid", type: "string" },
  { name: "terminatingruleid", type: "string" },
  { name: "terminatingruletype", type: "string" },
  { name: "action", type: "string" },
  { name: "httpsourcename", type: "string" },
  { name: "httpsourceid", type: "string" },
  {
    name: "rulegrouplist",
    type: "array<struct<rulegroupid:string,terminatingrule:struct<ruleid:string,action:string>,excludedrules:string,nonterminatingmatchingrules:array<struct<ruleid:string,action:string>>>>",
  },
  {
    name: "ratebasedrulelist",
    type: "array<struct<ratebasedruleid:string,limitkey:string,maxrateallowed:int>>",
  },
  {
    name: "nonterminatingmatchingrules",
    type: "array<struct<ruleid:string,action:string>>",
  },
  { name: "requestheadersinserted", type: "string" },
  { name: "responsecodesent", type: "string" },
  {
    name: "httprequest",
    type: "struct<clientip:string,country:string,headers:array<struct<name:string,value:string>>,uri:string,args:string,httpversion:string,httpmethod:string,requestid:string>",
  },
  { name: "labels", type: "array<struct<name:string>>" },
];
