import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { TEST_ACCOUNT, createCoreStack } from "./helpers.ts";

const ACCOUNT = TEST_ACCOUNT;

function synth(context: Record<string, string> = {}): Template {
  return Template.fromStack(createCoreStack(context));
}

interface GlueTableInput {
  Name: string;
  Parameters: Record<string, string>;
  StorageDescriptor: { Location: string };
}

function glueTable(name: string): GlueTableInput {
  const tables = Object.values(synth().findResources("AWS::Glue::Table")) as {
    Properties: { TableInput: GlueTableInput };
  }[];
  const table = tables.find((candidate) => candidate.Properties.TableInput.Name === name);
  if (!table) {
    throw new Error(`Glue テーブル ${name} が見つかりません`);
  }
  return table.Properties.TableInput;
}

describe("CoreStack", () => {
  let template: Template;

  beforeAll(() => {
    template = synth();
  });

  // SPEC 4.8 の必須検証項目
  it("すべての S3 バケットがパブリックアクセス全ブロック", () => {
    const buckets = template.findResources("AWS::S3::Bucket");
    expect(Object.keys(buckets).length).toBeGreaterThan(0);

    const allBlocked = {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    };
    // 論理 ID ごとに比較して、落ちたときにどのバケットかが差分に出るようにする
    expect(
      Object.fromEntries(
        Object.entries(buckets).map(([id, bucket]) => [
          id,
          bucket.Properties?.PublicAccessBlockConfiguration,
        ]),
      ),
    ).toEqual(Object.fromEntries(Object.keys(buckets).map((id) => [id, allBlocked])));
  });

  it("S3 バケットは暗号化と HTTPS 強制がかかっている", () => {
    const unencrypted = Object.entries(template.findResources("AWS::S3::Bucket"))
      .filter(([, bucket]) => bucket.Properties?.BucketEncryption === undefined)
      .map(([id]) => id);
    expect(unencrypted).toEqual([]);
    // enforceSSL は aws:SecureTransport=false を Deny するポリシーとして出る
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
        ]),
      }),
    });
  });

  it("サイトバケットは CloudFront サービスプリンシパルにのみ読ませる", () => {
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "AllowCloudFrontOacRead",
            Effect: "Allow",
            Action: "s3:GetObject",
            Principal: { Service: "cloudfront.amazonaws.com" },
            Condition: Match.objectLike({
              StringEquals: { "AWS:SourceAccount": ACCOUNT },
            }),
          }),
        ]),
      }),
    });
  });

  it("Cognito は Essentials プランで MFA optional・セルフサインアップ無効", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      UserPoolTier: "ESSENTIALS",
      MfaConfiguration: "OPTIONAL",
      AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
    });
  });

  it("パスワードポリシーが既定より強い", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      Policies: {
        PasswordPolicy: Match.objectLike({
          MinimumLength: 12,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
        }),
      },
    });
  });

  it("Managed Login のドメインを作る", () => {
    template.hasResourceProperties("AWS::Cognito::UserPoolDomain", {
      Domain: `edge-lab-${ACCOUNT}`,
    });
  });

  it("CSP コレクタは nodejs22.x で動く", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Handler: "index.handler",
    });
  });

  // 管理ポリシーは対象リソースを絞れない。自前ロールで最小権限にしてある
  // (CDK が自動生成するカスタムリソース用ロールは対象外)
  it("CSP コレクタのロールは AWS 管理ポリシーを使わない", () => {
    const roles = Object.entries(template.findResources("AWS::IAM::Role")).filter(([id]) =>
      id.startsWith("CspCollectorRole"),
    );
    expect(roles).toHaveLength(1);
    expect(roles[0][1].Properties?.ManagedPolicyArns ?? []).toEqual([]);
  });

  it("CSP コレクタの権限は自身のロググループ配下に限定されている", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
            Effect: "Allow",
          }),
        ]),
      }),
      Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp("^CspCollectorRole") }]),
    });
  });

  it("Origin シークレットは動的参照で渡し、平文をテンプレートに残さない", () => {
    const functions = template.findResources("AWS::Lambda::Function");
    const collector = Object.values(functions).find(
      (fn) => fn.Properties?.Environment?.Variables?.LAB_ORIGIN_SECRET !== undefined,
    );
    const value = collector?.Properties.Environment.Variables.LAB_ORIGIN_SECRET;
    expect(JSON.stringify(value)).toContain("{{resolve:secretsmanager:");
  });

  // シークレット名による動的参照は CloudFormation の依存グラフに現れないため、
  // 依存を明示しないと削除時にシークレットが先に消えて Lambda の削除が失敗する
  // (ResourceNotFoundException で DELETE_FAILED)。
  it("CSP コレクタはシークレットへの依存を明示している", () => {
    const functions = template.findResources("AWS::Lambda::Function");
    const [, collector] =
      Object.entries(functions).find(
        ([, fn]) => fn.Properties?.Environment?.Variables?.LAB_ORIGIN_SECRET !== undefined,
      ) ?? [];
    const secretIds = Object.keys(template.findResources("AWS::SecretsManager::Secret"));
    expect(secretIds).toHaveLength(1);
    expect(collector?.DependsOn ?? []).toContain(secretIds[0]);
  });

  it("CSP レポート API はスロットリングとアクセスログを持つ", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      DefaultRouteSettings: Match.objectLike({
        ThrottlingRateLimit: Match.anyValue(),
        ThrottlingBurstLimit: Match.anyValue(),
      }),
      AccessLogSettings: Match.objectLike({ DestinationArn: Match.anyValue() }),
    });
  });

  it("CSP レポートの受け口は POST /api/csp-report だけ", () => {
    const routes = Object.values(template.findResources("AWS::ApiGatewayV2::Route"));
    expect(routes.map((route) => route.Properties.RouteKey)).toEqual(["POST /api/csp-report"]);
  });

  it("Athena ワークグループが設定を強制する", () => {
    template.hasResourceProperties("AWS::Athena::WorkGroup", {
      WorkGroupConfiguration: Match.objectLike({
        EnforceWorkGroupConfiguration: true,
        ResultConfiguration: Match.objectLike({
          EncryptionConfiguration: { EncryptionOption: "SSE_S3" },
        }),
      }),
    });
  });

  // WAF ログバケットは WebACL 側のスタックが作るため、Glue テーブルは
  // クロススタック参照ではなく名前一致で解決する(OPEN_QUESTIONS Q5)
  it("エッジ用の Glue テーブルが us-east-1 の WAF ログバケットを指す", () => {
    const location = glueTable("edge_waf_logs").StorageDescriptor.Location;
    expect(location).toContain(`aws-waf-logs-edge-lab-edge-${ACCOUNT}`);
    expect(location).toContain("WAFLogs/us-east-1/edge-lab-edge");
  });

  it("Glue テーブルはパーティション射影を使う(MSCK 不要)", () => {
    for (const name of ["edge_waf_logs", "cognito_waf_logs"]) {
      const parameters = glueTable(name).Parameters;
      expect(parameters["projection.enabled"]).toBe("true");
      expect(parameters["storage.location.template"]).toContain("${year}");
    }
  });
});

describe("CoreStack の context 連動", () => {
  it("namePrefix がリソース名に反映される", () => {
    const template = synth({ namePrefix: "my-lab" });
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      UserPoolName: "my-lab-users",
    });
    template.hasResourceProperties("AWS::Athena::WorkGroup", {
      Name: "my-lab-waf-analysis",
    });
  });

  it("不正な context は synth 前に例外になる", () => {
    expect(() => synth({ phase: "p9" })).toThrow(/不正/);
  });
});
