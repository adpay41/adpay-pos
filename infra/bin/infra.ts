#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AdpayDevStack } from '../lib/adpay-dev-stack';

const app = new cdk.App();

// Account comes from the ambient AWS credentials at deploy time; region defaults to us-east-1.
// Built conditionally so `cdk synth` works with no credentials configured at all.
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION ?? 'us-east-1';

new AdpayDevStack(app, 'AdpayDevStack', {
  env: account ? { account, region } : { region },
  description:
    'AD Pay POS — dev environment (VPC, Postgres 16, Redis, Fargate, ALB). NOT DEPLOYED.',
  tags: { Project: 'adpay-pos', Environment: 'dev', Owner: 'American Dream Pay LLC' },
});
