import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import * as fs from 'fs';

export class CdkInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Retrieve Context values to eliminate hardcoding
    const vpcCidr = this.node.tryGetContext('vpcCidr') || '10.0.0.0/16';
    const instanceTypeStr = this.node.tryGetContext('instanceType') || 't2.micro';
    const asgMinCapacity = this.node.tryGetContext('asgMinCapacity') || 2;
    const asgMaxCapacity = this.node.tryGetContext('asgMaxCapacity') || 2;

    // 1. VPC (2 AZs, Public and Private Subnets)
    const vpc = new ec2.Vpc(this, 'MainVpc', {
      maxAzs: 2,
      natGateways: 1, // Reduced NAT Gateways to 1 for cost optimization
      vpcName: 'Main VPC',
      ipAddresses: ec2.IpAddresses.cidr(vpcCidr),
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'PublicSubnet',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'PrivateSubnet',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // Enable VPC Flow Logs
    vpc.addFlowLog('FlowLog');

    // 2. ALB Security Group
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'Allow HTTP traffic to ALB',
      allowAllOutbound: true,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP traffic');

    // 3. Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'AppAlb', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
    });

    const listener = alb.addListener('HttpListener', {
      port: 80,
      open: true,
    });

    // 4. App Server Security Group
    const appSg = new ec2.SecurityGroup(this, 'AppSg', {
      vpc,
      description: 'Allow traffic from ALB',
      allowAllOutbound: true, // required for SSM validation
    });
    appSg.addIngressRule(albSg, ec2.Port.tcp(80), 'Allow HTTP traffic from ALB');

    // 5. IAM Role with SSM Managed Policy
    const appRole = new iam.Role(this, 'AppRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // 6. AMI & User Data Setup
    const ami = ec2.MachineImage.latestAmazonLinux2023();

    // Define CloudFormation Init (cfn-init)
    const initConfig = ec2.CloudFormationInit.fromElements(
      ec2.InitPackage.yum('python3.13'),
      ec2.InitPackage.yum('python3.13-pip'),
      ec2.InitCommand.shellCommand('python3.13 -m pip install --upgrade pip'),
      ec2.InitCommand.shellCommand('python3.13 -m pip install fastapi uvicorn'),
      ec2.InitFile.fromAsset('/home/ec2-user/main.py', path.join(__dirname, '../../app/src/main.py'))
    );

    // Read userdata script from extracted file
    const scriptPath = path.join(__dirname, '../../scripts/user-data.sh');
    let userDataCommands = '';
    if (fs.existsSync(scriptPath)) {
      userDataCommands = fs.readFileSync(scriptPath, 'utf8');
    }

    // 7. Auto Scaling Group (ASG)
    const asg = new autoscaling.AutoScalingGroup(this, 'AppASG', {
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      instanceType: new ec2.InstanceType(instanceTypeStr),
      machineImage: ami,
      securityGroup: appSg,
      role: appRole,
      minCapacity: asgMinCapacity as number,
      maxCapacity: asgMaxCapacity as number,
      init: initConfig,
      signals: autoscaling.Signals.waitForAll({
        timeout: cdk.Duration.minutes(10),
      }),
    });

    // Apply extracted UserData commands
    if (userDataCommands) {
      asg.userData.addCommands(userDataCommands);
    }

    // Register ASG to ALB listener
    listener.addTargets('AppTargets', {
      port: 80,
      targets: [asg],
      healthCheck: {
        path: '/',
        healthyHttpCodes: '200',
      }
    });

    // Outputs
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: alb.loadBalancerDnsName,
      description: 'DNS Name of the ALB',
    });
  }
}
