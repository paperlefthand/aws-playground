/**
 * DeliveryStack(SPEC 4.2)— ap-northeast-1。
 *
 * **同一の S3 オリジン・同一のビルド成果物**に対して CloudFront を 2 本立てる。
 * hardened(WAF あり / セキュリティヘッダあり)と baseline(どちらも無し)を
 * 同時刻に測定するための構成で、時系列 before/after にすると交絡する
 * ネットワーク状況やスキャナのバージョン差を排除する(SPEC 2.1)。
 * **この 2 本立てを実装の都合で 1 本にしないこと。**
 *
 * Cognito App Client もここに置く。callback URL に CloudFront のドメインが要る
 * 一方、CSP には Cognito のドメインが要るため、両方を CoreStack に置くと
 * スタック間で循環参照になる(docs/OPEN_QUESTIONS.md Q7 の決定)。
 */

import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import type { LabContext } from "../config/context.ts";
import { CSP_CURRENT_VERSION, buildCspHeaderValue } from "../config/csp.ts";
import { ORIGIN_SECRET_HEADER, originSecretDynamicRef } from "../config/naming.ts";
import { buildSecurityHeaders } from "../config/security-headers.ts";

/** ハッシュ付きアセットの配信パス。Vite の既定に合わせる */
const ASSET_PATH_PATTERN = "/assets/*";

export interface DeliveryStackProps extends cdk.StackProps {
  readonly labContext: LabContext;
  /**
   * SPA 成果物のバケット「名」。CoreStack の Bucket をそのまま渡すと
   * `S3BucketOrigin.withOriginAccessControl()` が CoreStack 側のバケットポリシーに
   * このディストリビューションの ARN を書き込み、スタック間で循環参照になる。
   * OAC 用の許可は CoreStack 側でアカウント単位のワイルドカードとして
   * 与えてあるので、ここでは名前でインポートするだけにする。
   */
  readonly siteBucketName: string;
  readonly userPool: cognito.IUserPool;
  /** Managed Login のドメイン接頭辞 */
  readonly userPoolDomainPrefix: string;
  readonly cspApi: apigwv2.IHttpApi;
  /** us-east-1 の WebACL ARN(crossRegionReferences 経由) */
  readonly edgeWebAclArn: string;
}

export class DeliveryStack extends cdk.Stack {
  public readonly hardenedDistribution: cloudfront.Distribution;
  /** `baselineEnabled=false` のときは作られない */
  public readonly baselineDistribution?: cloudfront.Distribution;
  public readonly userPoolClient: cognito.UserPoolClient;
  /** CloudFront アクセスログの配信先 */
  public readonly accessLogBucket: s3.Bucket;
  public readonly cspValue?: string;

  public constructor(scope: Construct, id: string, props: DeliveryStackProps) {
    super(scope, id, props);

    const { labContext } = props;
    const cognitoDomain = `${props.userPoolDomainPrefix}.auth.${this.region}.amazoncognito.com`;

    this.cspValue =
      labContext.cspMode === "off"
        ? undefined
        : buildCspHeaderValue({
            region: this.region,
            cognitoDomain,
            trustedTypes: labContext.trustedTypes,
          });

    const siteBucket = s3.Bucket.fromBucketName(this, "SiteBucket", props.siteBucketName);
    this.accessLogBucket = this.createAccessLogBucket();
    const accessLogBucket = this.accessLogBucket;
    const spaRouter = this.createSpaRouterFunction();
    const cachePolicies = this.createCachePolicies();

    this.hardenedDistribution = this.createDistribution({
      id: "HardenedDistribution",
      comment: `edge-lab hardened (phase=${labContext.phase} csp=${labContext.cspMode})`,
      siteBucket,
      accessLogBucket,
      cspApi: props.cspApi,
      spaRouter,
      cachePolicies,
      namePrefix: labContext.namePrefix,
      // hardened だけが WebACL とセキュリティヘッダを持つ
      webAclArn: props.edgeWebAclArn,
      responseHeaders: this.createResponseHeadersPolicies(labContext),
    });

    if (labContext.baselineEnabled) {
      this.baselineDistribution = this.createDistribution({
        id: "BaselineDistribution",
        comment: "edge-lab baseline (no WAF, no security headers)",
        siteBucket,
        accessLogBucket,
        cspApi: props.cspApi,
        spaRouter,
        cachePolicies,
        namePrefix: labContext.namePrefix,
        // SPEC 4.2: baseline には WebACL もヘッダも一切付けない
        webAclArn: undefined,
        responseHeaders: undefined,
      });
    }

    this.userPoolClient = this.createUserPoolClient(props);
    this.createOutputs(cognitoDomain);
  }

  /**
   * CloudFront のアクセスログ。hardened / baseline を同条件で比較するため
   * 両方で有効にする(E1 / E7 の突き合わせに使う)。
   *
   * CloudFront の標準ログ配信は配信先バケットの ACL を使うため、
   * ACL 無効(BucketOwnerEnforced)のバケットには書けない。ここだけ
   * `BUCKET_OWNER_PREFERRED` にする必要がある。
   */
  private createAccessLogBucket(): s3.Bucket {
    return new s3.Bucket(this, "CloudFrontAccessLogs", {
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
  }

  private createSpaRouterFunction(): cloudfront.Function {
    return new cloudfront.Function(this, "SpaRouter", {
      code: cloudfront.FunctionCode.fromFile({
        filePath: path.join(import.meta.dirname, "..", "functions", "spa-router", "index.js"),
      }),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: "SPA path rewrite (see SPEC 4.2: custom error responses are not used)",
    });
  }

  private createCachePolicies(): {
    readonly html: cloudfront.ICachePolicy;
    readonly asset: cloudfront.CachePolicy;
  } {
    return {
      // index.html は即時反映させたい(CSP を変えたときに古い HTML が残らないように)。
      // 実際の `Cache-Control: no-store` は S3 のオブジェクトメタデータで付ける
      // (README のデプロイ手順参照)。ここでは CloudFront 側で保持させない。
      //
      // TTL を 0 にした自前ポリシーは作れない。CloudFront は maxTtl=0 のポリシーを
      // 「キャッシュ無効」と見なし、その状態では圧縮フラグ
      // (EnableAcceptEncodingGzip / Brotli)の指定が拒否されるため
      // (`AWS::CloudFront::CachePolicy: The parameter EnableAcceptEncodingGzip is
      // invalid for policy with caching disabled`)。
      //
      // 短い TTL(例: 1 秒)にすれば圧縮は残せるが、リクエストごとにエッジヒットの
      // 有無が変わり E7 のレイテンシ測定が不安定になる。再現性を優先して
      // 「常にオリジンへ行く」マネージドポリシーを使う。HTML は 1 KB 未満なので
      // 圧縮が効かない影響は無視できる(ハッシュ付きアセット側では圧縮している)。
      html: cloudfront.CachePolicy.CACHING_DISABLED,
      // ハッシュ付きアセットは内容が変われば URL が変わるので長期キャッシュしてよい
      asset: new cloudfront.CachePolicy(this, "AssetCachePolicy", {
        cachePolicyName: `${this.stackName}-asset`,
        comment: "hashed assets: cache for a year",
        defaultTtl: cdk.Duration.days(365),
        minTtl: cdk.Duration.days(365),
        maxTtl: cdk.Duration.days(365),
        enableAcceptEncodingGzip: true,
        enableAcceptEncodingBrotli: true,
      }),
    };
  }

  /**
   * hardened 用の ResponseHeadersPolicy。
   * ヘッダ値は config/security-headers.ts が単一情報源。
   */
  private createResponseHeadersPolicies(labContext: LabContext): {
    readonly html: cloudfront.ResponseHeadersPolicy;
    readonly asset: cloudfront.ResponseHeadersPolicy;
  } {
    const headers = buildSecurityHeaders({
      cspMode: labContext.cspMode,
      cspValue: this.cspValue,
    });

    const securityHeadersBehavior: cloudfront.ResponseSecurityHeadersBehavior = {
      strictTransportSecurity: {
        accessControlMaxAge: cdk.Duration.seconds(
          headers.native.strictTransportSecurity.accessControlMaxAgeSeconds,
        ),
        includeSubdomains: headers.native.strictTransportSecurity.includeSubdomains,
        preload: headers.native.strictTransportSecurity.preload,
        override: true,
      },
      contentTypeOptions: { override: true },
      frameOptions: {
        frameOption: cloudfront.HeadersFrameOption.DENY,
        override: true,
      },
      referrerPolicy: {
        referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
        override: true,
      },
      // SPEC 4.2: ネイティブ CSP フィールドは enforce 専用。
      // report-only は customHeaders 側で付ける。
      contentSecurityPolicy: headers.native.contentSecurityPolicy
        ? { contentSecurityPolicy: headers.native.contentSecurityPolicy, override: true }
        : undefined,
    };

    const toCustomHeaders = (extra: Record<string, string>): cloudfront.ResponseCustomHeader[] =>
      Object.entries({ ...headers.custom, ...extra }).map(([header, value]) => ({
        header,
        value,
        override: true,
      }));

    return {
      html: new cloudfront.ResponseHeadersPolicy(this, "HardenedHtmlHeaders", {
        responseHeadersPolicyName: `${this.stackName}-hardened-html`,
        comment: `security headers (CSP v${CSP_CURRENT_VERSION}, mode=${labContext.cspMode})`,
        securityHeadersBehavior,
        customHeadersBehavior: {
          customHeaders: toCustomHeaders({ "Cache-Control": "no-store" }),
        },
      }),
      asset: new cloudfront.ResponseHeadersPolicy(this, "HardenedAssetHeaders", {
        responseHeadersPolicyName: `${this.stackName}-hardened-asset`,
        comment: "security headers for hashed assets",
        securityHeadersBehavior,
        customHeadersBehavior: {
          customHeaders: toCustomHeaders({
            "Cache-Control": "public, max-age=31536000, immutable",
          }),
        },
      }),
    };
  }

  private createDistribution(options: {
    readonly id: string;
    readonly comment: string;
    readonly siteBucket: s3.IBucket;
    readonly accessLogBucket: s3.IBucket;
    readonly cspApi: apigwv2.IHttpApi;
    readonly spaRouter: cloudfront.Function;
    readonly cachePolicies: {
      readonly html: cloudfront.ICachePolicy;
      readonly asset: cloudfront.CachePolicy;
    };
    readonly namePrefix: string;
    readonly webAclArn: string | undefined;
    readonly responseHeaders:
      | {
          readonly html: cloudfront.ResponseHeadersPolicy;
          readonly asset: cloudfront.ResponseHeadersPolicy;
        }
      | undefined;
  }): cloudfront.Distribution {
    // OAI ではなく OAC を使う(SPEC 4.1)
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(options.siteBucket);

    // CloudFront と同一オリジンにして CORS を回避する。直叩きは Origin Custom
    // Header + Lambda 側の検証で弾く(SPEC 4.1)。
    const apiOrigin = new origins.HttpOrigin(
      cdk.Fn.select(2, cdk.Fn.split("/", options.cspApi.apiEndpoint)),
      {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        customHeaders: { [ORIGIN_SECRET_HEADER]: originSecretDynamicRef(options.namePrefix) },
      },
    );

    return new cloudfront.Distribution(this, options.id, {
      comment: options.comment,
      defaultRootObject: "index.html",
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      webAclId: options.webAclArn,
      enableLogging: true,
      logBucket: options.accessLogBucket,
      logFilePrefix: `${options.id}/`,
      logIncludesCookies: false,
      // SPEC 4.2: WAF の block(403)が index.html にすり替わらないよう
      // カスタムエラーレスポンスは使わず、CloudFront Function で書き換える
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: options.cachePolicies.html,
        responseHeadersPolicy: options.responseHeaders?.html,
        functionAssociations: [
          {
            function: options.spaRouter,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        [ASSET_PATH_PATTERN]: {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: options.cachePolicies.asset,
          responseHeadersPolicy: options.responseHeaders?.asset,
        },
        "/api/*": {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // Content-Type を含むビューアヘッダをオリジンに渡す必要がある
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: options.responseHeaders?.html,
        },
      },
    });
  }

  /**
   * SPEC 4.1 の要件どおりの public クライアント。
   * public client(シークレット無し)では Cognito が PKCE を必須にする。
   */
  private createUserPoolClient(props: DeliveryStackProps): cognito.UserPoolClient {
    const urls = [this.hardenedDistribution, this.baselineDistribution]
      .filter((distribution) => distribution !== undefined)
      .map((distribution) => `https://${distribution.distributionDomainName}`);

    return new cognito.UserPoolClient(this, "WebClient", {
      userPool: props.userPool,
      userPoolClientName: `${props.labContext.namePrefix}-web`,
      // public client。シークレットは持たせない
      generateSecret: false,
      // SRP / USER_PASSWORD などの直接認証フローは開けない。
      // ログインは Managed Login 経由の Authorization Code + PKCE だけにする。
      authFlows: {},
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          // 暗黙フローはトークンが URL に載るため無効(SPEC 4.1)
          implicitCodeGrant: false,
          clientCredentials: false,
        },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: urls.map((url) => `${url}/callback`),
        logoutUrls: urls,
      },
      // ユーザーの存在有無を応答から推測させない(E6 の測定条件にも効く)
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
    });
  }

  private createOutputs(cognitoDomain: string): void {
    new cdk.CfnOutput(this, "HardenedUrl", {
      value: `https://${this.hardenedDistribution.distributionDomainName}`,
      description: "WAF + security headers enabled",
    });
    if (this.baselineDistribution) {
      new cdk.CfnOutput(this, "BaselineUrl", {
        value: `https://${this.baselineDistribution.distributionDomainName}`,
        description: "No WAF, no security headers (control group)",
      });
    }
    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: this.userPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, "CognitoDomain", { value: cognitoDomain });
  }
}
