#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { EcsBgHandsOnStack } from '../lib/ecs-bg-deployment-stack';

const app = new cdk.App();
new EcsBgHandsOnStack(app, 'EcsBgDeploymentStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
