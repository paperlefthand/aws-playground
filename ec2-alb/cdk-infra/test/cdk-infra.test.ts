import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as CdkInfra from '../lib/cdk-infra-stack';

describe('CdkInfraStack Architecture Tests', () => {
  let app: cdk.App;
  let stack: CdkInfra.CdkInfraStack;
  let template: Template;

  beforeAll(() => {
    app = new cdk.App();
    stack = new CdkInfra.CdkInfraStack(app, 'MyTestStack');
    template = Template.fromStack(stack);
  });

  test('VPC is created with Flow Logs and 1 NAT Gateway', () => {
    template.resourceCountIs('AWS::EC2::VPC', 1);
    // 2 public subnets, 2 private subnets, but only 1 NAT Gateway
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
    // Flow Log should be enabled
    template.resourceCountIs('AWS::EC2::FlowLog', 1);
  });

  test('ALB is internet-facing and has correct Security Group', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing'
    });

    // Verify AlbSg exists with HTTP access from anywhere
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Allow HTTP traffic to ALB',
      SecurityGroupIngress: [
        Match.objectLike({
          IpProtocol: 'tcp',
          FromPort: 80,
          ToPort: 80,
          CidrIp: '0.0.0.0/0'
        })
      ]
    });
  });

  test('AutoScalingGroup (ASG) is created with bounds and SSM Role', () => {
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MinSize: '2',
      MaxSize: '2'
    });

    // Verify the IAM Role has SSM Core Managed Policy
    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: [
        {
          "Fn::Join": [
            "",
            [
              "arn:",
              { "Ref": "AWS::Partition" },
              ":iam::aws:policy/AmazonSSMManagedInstanceCore"
            ]
          ]
        }
      ]
    });
  });

  test('AppSg allows HTTP from AlbSg', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 80,
      ToPort: 80,
      GroupId: Match.anyValue(),
      SourceSecurityGroupId: Match.anyValue(),
      Description: 'Allow HTTP traffic from ALB'
    });
  });

  test('cfn-init sets up python3.13 packages and FastAPI', () => {
    template.hasResource('AWS::AutoScaling::AutoScalingGroup', {
      Metadata: {
        'AWS::CloudFormation::Init': Match.objectLike({
          config: Match.objectLike({
            packages: {
              yum: Match.objectLike({
                'python3.13': Match.anyValue(),
                'python3.13-pip': Match.anyValue(),
              })
            },
            commands: Match.objectLike({
              "000": Match.objectLike({
                command: "python3.13 -m pip install --upgrade pip"
              }),
              "001": Match.objectLike({
                command: "python3.13 -m pip install fastapi uvicorn"
              })
            })
          })
        })
      }
    });
  });
});
