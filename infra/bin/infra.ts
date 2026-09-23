#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AdpayDevStack } from '../lib/adpay-dev-stack';

const app = new cdk.App();

new AdpayDevStack(app, 'AdpayDevStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'AD Pay POS — dev environment (VPC, Postgres 16, Redis, Fargate, ALB). NOT DEPLOYED.',
  tags: { Project: 'adpay-pos', Environment: 'dev', Owner: 'American Dream Pay LLC' },
});
