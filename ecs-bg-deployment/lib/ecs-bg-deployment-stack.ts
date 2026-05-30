import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';

export class EcsBgHandsOnStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. VPCの構築
    const vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 2, natGateways: 1 });

    // 2. ECSクラスターの構築（負荷試験のスケールアウト可視化のため Container Insights を有効化）
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // 3. ALBと2つのリスナー（本番用とテスト用）の構築
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', { vpc, internetFacing: true });
    const prodListener = alb.addListener('ProdListener', { port: 80 });
    const testListener = alb.addListener('TestListener', { port: 8080 });

    // 4. Blue / Green 用の2つのターゲットグループ
    const blueGroup = new elbv2.ApplicationTargetGroup(this, 'BlueGroup', {
      vpc, port: 80, targetType: elbv2.TargetType.IP,
      healthCheck: { path: '/', healthyHttpCodes: '200', interval: cdk.Duration.seconds(15) }
    });
    const greenGroup = new elbv2.ApplicationTargetGroup(this, 'GreenGroup', {
      vpc, port: 80, targetType: elbv2.TargetType.IP,
      healthCheck: { path: '/', healthyHttpCodes: '200', interval: cdk.Duration.seconds(15) }
    });

    prodListener.addTargetGroups('BlueTarget', { targetGroups: [blueGroup] });
    testListener.addTargetGroups('GreenTarget', { targetGroups: [greenGroup] });

    // 5. ECSタスク定義（初期状態は正常なNginx）
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: '/ecs/ecs-bg-deployment',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_WEEK,
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef');
    const container = taskDef.addContainer('WebContainer', {
      image: ecs.ContainerImage.fromRegistry('nginx:latest'),
      portMappings: [{ containerPort: 80 }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'nginx',
        logGroup,
      }),
    });

    // 6. ECSサービス（デプロイメントコントローラを「EXTERNAL」に設定）
    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      deploymentController: { type: ecs.DeploymentControllerType.CODE_DEPLOY },
      desiredCount: 1,
    });
    // 初期状態としてBlueグループにアタッチ
    service.attachToApplicationTargetGroup(blueGroup);

    // 7. CodeDeploy アプリケーションとデプロイメントグループ
    const application = new codedeploy.EcsApplication(this, 'CodeDeployApp');
    new codedeploy.EcsDeploymentGroup(this, 'BlueGreenDG', {
      application,
      service,
      blueGreenDeploymentConfig: {
        blueTargetGroup: blueGroup,
        greenTargetGroup: greenGroup,
        listener: prodListener,
        testListener: testListener,
        // 古いタスク（Blue）を終了させるまでの待機時間
        terminationWaitTime: cdk.Duration.minutes(5),
      },
      // 一気にトラフィックを切り替える設定
      deploymentConfig: codedeploy.EcsDeploymentConfig.ALL_AT_ONCE,
      // 【重要】デプロイ失敗時の自動ロールバックを有効化
      autoRollback: { failedDeployment: true },
    });

    // 8. Application Auto Scaling（ALBリクエスト数ベースのターゲット追跡）
    //    K6で負荷をかけると RequestCountPerTarget がしきい値を超え、タスクがスケールアウトする
    const scaling = service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 6,
    });
    scaling.scaleOnRequestCount('RequestScaling', {
      // 1タスクあたり毎分50リクエストを超えたら増やす（ローカルK6で容易に発火する値、実験で調整可）
      requestsPerTarget: 50,
      targetGroup: blueGroup, // 本番(prod)リスナーに紐づく稼働中ターゲットグループ
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // 9. CloudWatch ダッシュボード（スケールアウトの様子を可視化）
    const dashboard = new cloudwatch.Dashboard(this, 'LoadTestDashboard', {
      dashboardName: 'ecs-bg-loadtest',
    });

    // タスク数は Container Insights の ECS/ContainerInsights 名前空間から取得
    const runningTasks = new cloudwatch.Metric({
      namespace: 'ECS/ContainerInsights',
      metricName: 'RunningTaskCount',
      dimensionsMap: {
        ClusterName: cluster.clusterName,
        ServiceName: service.serviceName,
      },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'ECS Running Task Count（スケールアウト）',
        left: [runningTasks],
      }),
      new cloudwatch.GraphWidget({
        title: 'ECS CPU / Memory Utilization',
        left: [service.metricCpuUtilization(), service.metricMemoryUtilization()],
      }),
      new cloudwatch.GraphWidget({
        title: 'ALB Request Count / Per Target',
        left: [blueGroup.metrics.requestCount()],
        right: [blueGroup.metrics.requestCountPerTarget()],
      }),
      new cloudwatch.GraphWidget({
        title: 'ALB Target Response Time',
        left: [blueGroup.metrics.targetResponseTime()],
      }),
    );

    // 確認用にALBのDNS名を出力
    new cdk.CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName });

    // CloudWatch ダッシュボードのURLを出力
    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=ecs-bg-loadtest`,
    });
  }
}