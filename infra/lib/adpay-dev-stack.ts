import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';

/**
 * AD Pay POS — dev environment.
 *
 * NOT DEPLOYED. `cdk synth` and `cdk diff` only until the founder approves the spend.
 * Everything here is the smallest instance class that exists; this is a dev stack, not a
 * production one. See docs/decisions/0005-iac-aws-cdk.md.
 */
export class AdpayDevStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------- network
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // --------------------------------------------------------------- postgres
    const dbSg = new ec2.SecurityGroup(this, 'DbSg', { vpc, description: 'adpay dev postgres' });

    const db = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_4,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      multiAz: false,
      databaseName: 'adpay',
      // Credentials are generated into Secrets Manager. No credential is ever in this file.
      credentials: rds.Credentials.fromGeneratedSecret('adpay', { secretName: 'adpay/dev/db' }),
      backupRetention: cdk.Duration.days(7),
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev only
    });

    // ------------------------------------------------------------------ redis
    const redisSg = new ec2.SecurityGroup(this, 'RedisSg', { vpc, description: 'adpay dev redis' });

    const redisSubnets = new elasticache.CfnSubnetGroup(this, 'RedisSubnets', {
      description: 'adpay dev redis',
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
    });

    const redis = new elasticache.CfnCacheCluster(this, 'Redis', {
      engine: 'redis',
      cacheNodeType: 'cache.t4g.micro',
      numCacheNodes: 1,
      cacheSubnetGroupName: redisSubnets.ref,
      vpcSecurityGroupIds: [redisSg.securityGroupId],
    });
    redis.addDependency(redisSubnets);

    // ------------------------------------------------------------- ecs + alb
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, containerInsights: false });

    const serviceSg = new ec2.SecurityGroup(this, 'ApiSg', { vpc, description: 'adpay dev api' });
    dbSg.addIngressRule(serviceSg, ec2.Port.tcp(5432), 'api → postgres');
    redisSg.addIngressRule(serviceSg, ec2.Port.tcp(6379), 'api → redis');

    const taskDef = new ecs.FargateTaskDefinition(this, 'ApiTask', { cpu: 256, memoryLimitMiB: 512 });

    taskDef.addContainer('api', {
      // Placeholder until the first image is pushed to the adpay-api ECR repo.
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/node:20-alpine'),
      command: ['node', '-e', "require('http').createServer((_,r)=>r.end('ok')).listen(3000)"],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'adpay-api',
        logRetention: logs.RetentionDays.ONE_MONTH,
      }),
      environment: {
        NODE_ENV: 'development',
        AWS_REGION: cdk.Stack.of(this).region,
        REDIS_URL: `redis://${redis.attrRedisEndpointAddress}:${redis.attrRedisEndpointPort}`,
        PAYMENT_PROVIDER: 'stub',
      },
      // DATABASE_URL components come from Secrets Manager by reference, never from this file.
      secrets: {
        DB_SECRET: ecs.Secret.fromSecretsManager(db.secret!),
      },
      portMappings: [{ containerPort: 3000 }],
    });

    const service = new ecs.FargateService(this, 'ApiService', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 0, // stays at 0 until a real image exists
      securityGroups: [serviceSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', { vpc, internetFacing: true });

    const listener = alb.addListener('Http', {
      port: 80,
      open: true, // TLS listener is added once a domain and certificate exist
    });

    listener.addTargets('ApiTarget', {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: { path: '/health', healthyHttpCodes: '200' },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ---------------------------------------------------------------- outputs
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
    new cdk.CfnOutput(this, 'DbEndpoint', { value: db.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, 'DbSecretName', { value: 'adpay/dev/db' });
    new cdk.CfnOutput(this, 'RedisEndpoint', { value: redis.attrRedisEndpointAddress });
    new cdk.CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
  }
}
