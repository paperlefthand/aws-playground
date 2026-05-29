#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib/core';
import { CdkInfraStack } from '../lib/cdk-infra-stack';

const app = new cdk.App();
new CdkInfraStack(app, 'CdkInfraStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-northeast-1' },
});
