// Node icons: the single source of truth for the library's icons and logos (spec 2026-10-18, RC-687).
// Zero imports, erasable TypeScript only, ES2021 APIs only: the module bundle, the client,
// the agent, the hosted MCP and `node --experimental-strip-types` all load this file as is.
// An id is stored in node_icon.icon and is never renamed. The drawings live in the client
// (client/src/node-icons.ts), keyed by these ids.

export type IconSection = 'agents' | 'systems' | 'ai' | 'cloud' | 'aws' | 'azure' | 'gcp' | 'cloudflare' | 'databases' | 'kubernetes' | 'cncf';
/** The kinds an icon node may have; boundary takes an icon beside its label. */
export type IconKind = 'service' | 'datastore' | 'external';

export interface IconSpec {
  id: string;
  section: IconSection;
  /** Tile label, and the label a placed node starts with. */
  name: string;
  /** The kind a placed node starts with; the person or agent can change it. */
  kind: IconKind;
  /** Extra search words; the name, the id and the section title match too. */
  terms: readonly string[];
}

/** The sections in library order. A `pack` is one product family; its `logo` is the id of the
 *  icon that stands for it in the library, and a pack with none gets a neutral glyph. */
export const ICON_SECTIONS: ReadonlyArray<{ id: IconSection; title: string; pack?: true; logo?: string }> = [
  { id: 'agents', title: 'Agents' },
  { id: 'systems', title: 'Systems' },
  { id: 'ai', title: 'AI logos' },
  { id: 'cloud', title: 'Cloud logos' },
  { id: 'aws', title: 'AWS', pack: true, logo: 'aws' },
  { id: 'azure', title: 'Microsoft Azure', pack: true, logo: 'azure' },
  { id: 'gcp', title: 'Google Cloud', pack: true, logo: 'google-cloud' },
  { id: 'cloudflare', title: 'Cloudflare', pack: true, logo: 'cloudflare' },
  { id: 'databases', title: 'Databases', pack: true },
  { id: 'kubernetes', title: 'Kubernetes', pack: true, logo: 'kubernetes' },
  { id: 'cncf', title: 'CNCF', pack: true },
];

const icon = (section: IconSection, kind: IconKind) => (id: string, name: string, terms: readonly string[]): IconSpec => ({ id, section, name, kind, terms });
const agent = (kind: IconKind) => icon('agents', kind);
const system = (kind: IconKind) => icon('systems', kind);
const ai = icon('ai', 'external');
const cloud = icon('cloud', 'external');
const svc = (section: IconSection) => icon(section, 'service');
const store = (section: IconSection) => icon(section, 'datastore');
const brand = (section: IconSection) => icon(section, 'external');

export const ICONS: readonly IconSpec[] = [
  agent('service')('agent', 'Agent', ['ai', 'bot', 'assistant', 'autonomous', 'llm agent']),
  agent('service')('orchestrator', 'Orchestrator', ['planner', 'supervisor', 'coordinator', 'router', 'multi-agent', 'lead agent']),
  agent('service')('subagent', 'Sub-agent', ['subagent', 'worker', 'delegate', 'child agent', 'specialist', 'task agent']),
  agent('external')('model', 'Model', ['llm', 'foundation model', 'inference', 'completion', 'claude', 'gpt', 'gemini']),
  agent('service')('tool', 'Tool', ['function', 'tool call', 'action', 'plugin', 'skill']),
  agent('external')('mcp-server', 'MCP server', ['mcp', 'model context protocol', 'connector', 'integration', 'server', 'plug']),
  agent('datastore')('memory', 'Memory', ['context', 'state', 'history', 'scratchpad', 'long-term memory', 'session']),
  agent('datastore')('knowledge-base', 'Knowledge base', ['rag', 'retrieval', 'vector store', 'embeddings', 'docs', 'index', 'search']),
  agent('datastore')('prompt', 'Prompt', ['system prompt', 'instructions', 'template', 'context file', 'claude.md']),
  agent('external')('human', 'Human', ['user', 'person', 'reviewer', 'approval', 'human in the loop', 'hitl', 'operator']),
  agent('service')('guardrail', 'Guardrail', ['safety', 'policy', 'filter', 'moderation', 'validator', 'permission']),
  agent('service')('evaluator', 'Evaluator', ['eval', 'judge', 'grader', 'scorer', 'benchmark', 'llm as judge']),

  system('datastore')('queue', 'Queue', ['message queue', 'buffer', 'job queue', 'sqs', 'kafka', 'backlog']),
  system('datastore')('cache', 'Cache', ['redis', 'memcached', 'fast', 'kv', 'key value', 'cdn']),
  system('service')('scheduler', 'Scheduler', ['cron', 'timer', 'job', 'schedule', 'clock', 'periodic']),
  system('service')('event', 'Event', ['webhook', 'trigger', 'pubsub', 'topic', 'stream', 'notification', 'event bus']),
  system('service')('gateway', 'Gateway', ['api gateway', 'load balancer', 'proxy', 'router', 'ingress', 'edge']),
  system('service')('function', 'Function', ['serverless', 'lambda', 'worker', 'handler', 'cloud function', 'faas']),
  system('external')('browser', 'Browser', ['client', 'web app', 'frontend', 'ui', 'computer use', 'website']),
  system('service')('sandbox', 'Sandbox', ['code execution', 'interpreter', 'container', 'runtime', 'terminal', 'vm', 'shell']),

  // AI logos follow each brand's own guidelines too (spec D17), drawn from their own files.
  // Claude and Claude Code use the Spark from Anthropic's public press kit (Alan, 2026-10-19).
  // Codex has no official logo; Gemini and the others need written permission first (spec, "AI logos").
  ai('claude', 'Claude', ['anthropic', 'opus', 'sonnet', 'haiku', 'fable', 'model']),
  ai('claude-code', 'Claude Code', ['anthropic', 'cli', 'coding agent']),
  // OpenAI's Marks usage terms accepted by Alan, 2026-10-19.
  ai('openai', 'OpenAI', ['chatgpt', 'gpt', 'model']),
  ai('grok', 'Grok', ['xai', 'x.ai', 'model']),
  ai('mistral', 'Mistral', ['mistral ai', 'le chat', 'codestral', 'model']),
  ai('hugging-face', 'Hugging Face', ['hf', 'transformers', 'hub', 'model']),
  ai('openrouter', 'OpenRouter', ['model router', 'gateway', 'model']),
  ai('cursor', 'Cursor', ['ide', 'editor', 'anysphere', 'coding agent']),
  ai('github-copilot', 'GitHub Copilot', ['copilot', 'github', 'microsoft', 'coding agent']),
  ai('windsurf', 'Windsurf', ['codeium', 'cognition', 'ide', 'coding agent']),
  ai('devin', 'Devin', ['cognition', 'coding agent']),
  ai('openclaw', 'OpenClaw', ['clawdbot', 'moltbot', 'personal assistant', 'lobster', 'agent']),
  ai('hermes-agent', 'Hermes Agent', ['hermes', 'nous research', 'nous', 'agent']),
  ai('opencode', 'OpenCode', ['sst', 'cli', 'coding agent']),

  // Cloud logos follow each provider's brand guidelines (spec D18): only the ones whose
  // published rules allow a diagram tool to show their mark. The others need written
  // permission first (spec, "Cloud logos").
  cloud('vercel', 'Vercel', ['next.js', 'edge', 'hosting', 'cloud']),
  cloud('supabase', 'Supabase', ['postgres', 'database', 'auth', 'backend']),
  cloud('firebase', 'Firebase', ['google', 'firestore', 'backend']),
  cloud('neon', 'Neon', ['postgres', 'database', 'serverless postgres']),

  // Packs: one section per product family, each product named as its owner names it. AWS and
  // Azure take the names their rules ask for; Google Cloud, CNCF and Valkey art accepted by
  // Alan, 2026-11-03. Cloudflare and the databases draw neutral icons until their owners give
  // permission (the ids stay when art arrives). Google's kits hold no company mark, so
  // google-cloud draws a neutral icon until an official one is available. The first entry of a
  // pack stands for it.
  brand('aws')('aws', 'AWS Cloud', ['aws', 'amazon web services', 'amazon', 'ec2', 's3', 'lambda', 'cloud']),
  svc('aws')('aws-ec2', 'Amazon EC2', ['ec2', 'virtual machine', 'vm', 'server', 'compute', 'instance']),
  svc('aws')('aws-lambda', 'AWS Lambda', ['lambda', 'serverless', 'function', 'faas']),
  svc('aws')('aws-ecs', 'Amazon ECS', ['ecs', 'container', 'docker', 'orchestration']),
  svc('aws')('aws-eks', 'Amazon EKS', ['eks', 'kubernetes', 'managed k8s', 'container']),
  svc('aws')('aws-fargate', 'AWS Fargate', ['fargate', 'serverless container', 'container', 'ecs']),
  svc('aws')('aws-batch', 'AWS Batch', ['batch', 'batch job', 'job', 'compute']),
  store('aws')('aws-s3', 'Amazon S3', ['s3', 'blob', 'object storage', 'bucket', 'storage', 'file']),
  store('aws')('aws-ebs', 'Amazon EBS', ['ebs', 'block storage', 'volume', 'disk', 'storage']),
  store('aws')('aws-efs', 'Amazon EFS', ['efs', 'file system', 'nfs', 'shared storage', 'storage']),
  store('aws')('aws-glacier', 'Amazon S3 Glacier', ['glacier', 'archive', 'cold storage', 'backup', 's3', 'storage']),
  store('aws')('aws-rds', 'Amazon RDS', ['rds', 'relational', 'sql', 'database', 'postgres', 'mysql']),
  store('aws')('aws-aurora', 'Amazon Aurora', ['aurora', 'relational', 'sql', 'database', 'postgres', 'mysql']),
  store('aws')('aws-dynamodb', 'Amazon DynamoDB', ['dynamodb', 'dynamo', 'nosql', 'key value', 'database']),
  store('aws')('aws-elasticache', 'Amazon ElastiCache', ['elasticache', 'cache', 'redis', 'memcached', 'valkey']),
  store('aws')('aws-redshift', 'Amazon Redshift', ['redshift', 'data warehouse', 'warehouse', 'analytics', 'olap', 'sql']),
  store('aws')('aws-documentdb', 'Amazon DocumentDB', ['documentdb', 'document database', 'mongodb', 'nosql', 'database']),
  store('aws')('aws-opensearch', 'Amazon OpenSearch Service', ['opensearch', 'elasticsearch', 'search', 'index', 'logs']),
  store('aws')('aws-sqs', 'Amazon SQS', ['sqs', 'queue', 'message queue', 'messaging']),
  svc('aws')('aws-sns', 'Amazon SNS', ['sns', 'pubsub', 'topic', 'notification', 'fanout', 'messaging']),
  svc('aws')('aws-eventbridge', 'Amazon EventBridge', ['eventbridge', 'event bus', 'event', 'events', 'cloudwatch events']),
  store('aws')('aws-kinesis', 'Amazon Kinesis', ['kinesis', 'stream', 'streaming', 'data stream', 'ingest']),
  store('aws')('aws-msk', 'Amazon MSK', ['msk', 'kafka', 'stream', 'streaming', 'message queue']),
  svc('aws')('aws-step-functions', 'AWS Step Functions', ['step functions', 'state machine', 'workflow', 'orchestration']),
  svc('aws')('aws-api-gateway', 'Amazon API Gateway', ['api gateway', 'api', 'rest', 'http api', 'gateway']),
  svc('aws')('aws-cloudfront', 'Amazon CloudFront', ['cloudfront', 'cdn', 'edge', 'content delivery']),
  svc('aws')('aws-route-53', 'Amazon Route 53', ['route 53', 'route53', 'dns', 'domain']),
  svc('aws')('aws-elb', 'Elastic Load Balancing', ['elb', 'alb', 'nlb', 'lb', 'load balancer', 'load balancing']),
  svc('aws')('aws-vpc', 'Amazon VPC', ['vpc', 'virtual private cloud', 'network', 'subnet']),
  svc('aws')('aws-iam', 'AWS IAM', ['iam', 'identity', 'access', 'permissions', 'roles', 'policy']),
  svc('aws')('aws-cognito', 'Amazon Cognito', ['cognito', 'auth', 'authentication', 'user pool', 'identity', 'login']),
  svc('aws')('aws-kms', 'AWS KMS', ['kms', 'key management', 'encryption', 'keys']),
  svc('aws')('aws-secrets-manager', 'AWS Secrets Manager', ['secrets manager', 'secrets', 'credentials', 'vault']),
  svc('aws')('aws-waf', 'AWS WAF', ['waf', 'web application firewall', 'firewall', 'security']),
  svc('aws')('aws-cloudwatch', 'Amazon CloudWatch', ['cloudwatch', 'monitoring', 'metrics', 'logs', 'alarms', 'observability']),
  svc('aws')('aws-cloudtrail', 'AWS CloudTrail', ['cloudtrail', 'audit', 'audit log', 'logging']),
  store('aws')('aws-ecr', 'Amazon ECR', ['ecr', 'container registry', 'registry', 'docker images', 'images']),
  svc('aws')('aws-codepipeline', 'AWS CodePipeline', ['codepipeline', 'ci', 'cd', 'ci/cd', 'pipeline', 'deploy']),
  svc('aws')('aws-cloudformation', 'AWS CloudFormation', ['cloudformation', 'infrastructure as code', 'iac', 'template', 'stack']),
  svc('aws')('aws-bedrock', 'Amazon Bedrock', ['bedrock', 'llm', 'foundation model', 'generative ai', 'model']),
  svc('aws')('aws-sagemaker', 'Amazon SageMaker', ['sagemaker', 'machine learning', 'ml', 'training', 'model']),

  brand('azure')('azure', 'Microsoft Azure', ['azure', 'microsoft', 'cloud']),
  svc('azure')('azure-virtual-machines', 'Azure Virtual Machines', ['virtual machines', 'vm', 'vms', 'server', 'compute']),
  svc('azure')('azure-app-service', 'Azure App Service', ['app service', 'web app', 'hosting', 'paas']),
  svc('azure')('azure-functions', 'Azure Functions', ['functions', 'serverless', 'function', 'faas']),
  svc('azure')('azure-aks', 'Azure Kubernetes Service', ['aks', 'kubernetes', 'managed k8s', 'container']),
  svc('azure')('azure-container-apps', 'Azure Container Apps', ['container apps', 'container', 'serverless container']),
  svc('azure')('azure-container-instances', 'Azure Container Instances', ['container instances', 'aci', 'container']),
  store('azure')('azure-storage-accounts', 'Azure Storage Accounts', ['storage account', 'storage', 'blob', 'object storage', 'queue', 'table']),
  store('azure')('azure-blob-storage', 'Azure Blob Storage', ['blob', 'object storage', 'bucket', 'storage', 'file']),
  store('azure')('azure-files', 'Azure Files', ['files', 'file share', 'smb', 'file system', 'storage']),
  store('azure')('azure-managed-disks', 'Azure Managed Disks', ['managed disks', 'disk', 'block storage', 'volume', 'storage']),
  store('azure')('azure-sql', 'Azure SQL Database', ['sql', 'sql server', 'mssql', 'relational', 'database']),
  store('azure')('azure-cosmos-db', 'Azure Cosmos DB', ['cosmos', 'cosmosdb', 'nosql', 'document', 'database']),
  store('azure')('azure-postgresql', 'Azure Database for PostgreSQL', ['postgresql', 'postgres', 'relational', 'sql', 'database']),
  store('azure')('azure-mysql', 'Azure Database for MySQL', ['mysql', 'relational', 'sql', 'database']),
  store('azure')('azure-cache', 'Azure Cache for Redis', ['cache', 'redis', 'in-memory']),
  store('azure')('azure-synapse', 'Azure Synapse Analytics', ['synapse', 'data warehouse', 'warehouse', 'analytics', 'sql']),
  svc('azure')('azure-data-factory', 'Azure Data Factory', ['data factory', 'adf', 'etl', 'pipeline', 'data integration']),
  svc('azure')('azure-databricks', 'Azure Databricks', ['databricks', 'spark', 'analytics', 'lakehouse']),
  store('azure')('azure-service-bus', 'Azure Service Bus', ['service bus', 'queue', 'message queue', 'topic', 'messaging']),
  svc('azure')('azure-event-grid', 'Azure Event Grid', ['event grid', 'event', 'events', 'pubsub', 'event bus']),
  store('azure')('azure-event-hubs', 'Azure Event Hubs', ['event hubs', 'stream', 'streaming', 'kafka', 'ingest']),
  svc('azure')('azure-logic-apps', 'Azure Logic Apps', ['logic apps', 'workflow', 'automation', 'integration']),
  svc('azure')('azure-api-management', 'Azure API Management', ['api management', 'apim', 'api', 'gateway', 'api gateway']),
  svc('azure')('azure-front-door', 'Azure Front Door', ['front door', 'cdn', 'edge', 'load balancing', 'waf']),
  svc('azure')('azure-cdn', 'Azure CDN', ['cdn', 'content delivery', 'edge']),
  svc('azure')('azure-dns', 'Azure DNS', ['dns', 'domain', 'name resolution']),
  svc('azure')('azure-load-balancer', 'Azure Load Balancer', ['load balancer', 'load balancing', 'lb', 'layer 4']),
  svc('azure')('azure-application-gateway', 'Azure Application Gateway', ['application gateway', 'layer 7', 'load balancer', 'waf', 'gateway']),
  svc('azure')('azure-virtual-network', 'Azure Virtual Network', ['virtual network', 'vnet', 'network', 'subnet']),
  svc('azure')('azure-firewall', 'Azure Firewall', ['firewall', 'network security', 'security']),
  svc('azure')('azure-key-vault', 'Azure Key Vault', ['key vault', 'keys', 'secrets', 'certificates', 'encryption', 'vault']),
  svc('azure')('azure-monitor', 'Azure Monitor', ['monitor', 'monitoring', 'metrics', 'alerts', 'observability']),
  store('azure')('azure-log-analytics', 'Azure Log Analytics', ['log analytics', 'logs', 'logging', 'kql', 'workspace']),
  svc('azure')('azure-app-insights', 'Azure Application Insights', ['application insights', 'app insights', 'apm', 'tracing', 'telemetry', 'observability']),
  store('azure')('azure-container-registry', 'Azure Container Registry', ['container registry', 'acr', 'registry', 'docker images', 'images']),
  svc('azure')('azure-devops', 'Azure DevOps', ['devops', 'ci', 'cd', 'ci/cd', 'pipelines', 'boards', 'repos']),
  svc('azure')('azure-openai', 'Azure OpenAI', ['openai', 'gpt', 'llm', 'generative ai', 'model']),
  svc('azure')('azure-machine-learning', 'Azure Machine Learning', ['machine learning', 'azure ml', 'ml', 'training', 'model']),
  svc('azure')('azure-static-web-apps', 'Azure Static Web Apps', ['static web apps', 'static site', 'hosting', 'jamstack', 'frontend']),

  brand('gcp')('google-cloud', 'Google Cloud', ['google cloud', 'gcp', 'google', 'cloud']),
  svc('gcp')('gcp-compute-engine', 'Compute Engine', ['gce', 'virtual machine', 'vm', 'server', 'compute', 'instance']),
  svc('gcp')('gcp-cloud-run', 'Cloud Run', ['run', 'serverless', 'container', 'knative']),
  svc('gcp')('gcp-cloud-functions', 'Cloud Functions', ['functions', 'serverless', 'function', 'faas']),
  svc('gcp')('gcp-gke', 'Google Kubernetes Engine', ['gke', 'kubernetes', 'managed k8s', 'container']),
  svc('gcp')('gcp-app-engine', 'App Engine', ['gae', 'paas', 'web app', 'hosting']),
  store('gcp')('gcp-cloud-storage', 'Cloud Storage', ['gcs', 'blob', 'object storage', 'bucket', 'storage', 'file']),
  store('gcp')('gcp-filestore', 'Filestore', ['file system', 'nfs', 'shared storage', 'storage']),
  store('gcp')('gcp-persistent-disk', 'Persistent Disk', ['pd', 'block storage', 'volume', 'disk', 'storage']),
  store('gcp')('gcp-cloud-sql', 'Cloud SQL', ['sql', 'relational', 'postgres', 'mysql', 'sql server', 'database']),
  store('gcp')('gcp-spanner', 'Spanner', ['cloud spanner', 'relational', 'sql', 'global', 'database']),
  store('gcp')('gcp-alloydb', 'AlloyDB', ['alloy', 'postgres', 'relational', 'sql', 'database']),
  store('gcp')('gcp-firestore', 'Firestore', ['nosql', 'document', 'datastore', 'database']),
  store('gcp')('gcp-bigtable', 'Bigtable', ['nosql', 'wide column', 'hbase', 'database']),
  store('gcp')('gcp-memorystore', 'Memorystore', ['cache', 'redis', 'valkey', 'memcached', 'in-memory']),
  store('gcp')('gcp-bigquery', 'BigQuery', ['bq', 'data warehouse', 'warehouse', 'analytics', 'olap', 'sql']),
  svc('gcp')('gcp-dataflow', 'Dataflow', ['beam', 'apache beam', 'stream processing', 'etl', 'pipeline']),
  svc('gcp')('gcp-dataproc', 'Dataproc', ['spark', 'hadoop', 'cluster', 'batch', 'analytics']),
  store('gcp')('gcp-pubsub', 'Pub/Sub', ['pubsub', 'topic', 'subscription', 'queue', 'message queue', 'messaging']),
  store('gcp')('gcp-cloud-tasks', 'Cloud Tasks', ['tasks', 'task queue', 'queue', 'job queue']),
  svc('gcp')('gcp-cloud-scheduler', 'Cloud Scheduler', ['scheduler', 'cron', 'timer', 'schedule']),
  svc('gcp')('gcp-workflows', 'Workflows', ['workflow', 'orchestration', 'automation']),
  svc('gcp')('gcp-apigee', 'Apigee', ['api management', 'api', 'api gateway', 'gateway']),
  svc('gcp')('gcp-api-gateway', 'API Gateway', ['api', 'rest', 'gateway', 'api gateway']),
  svc('gcp')('gcp-load-balancing', 'Cloud Load Balancing', ['load balancer', 'load balancing', 'lb', 'glb']),
  svc('gcp')('gcp-cloud-cdn', 'Cloud CDN', ['cdn', 'edge', 'content delivery']),
  svc('gcp')('gcp-cloud-dns', 'Cloud DNS', ['dns', 'domain', 'name resolution']),
  svc('gcp')('gcp-vpc', 'Virtual Private Cloud', ['vpc', 'network', 'subnet']),
  svc('gcp')('gcp-cloud-armor', 'Cloud Armor', ['armor', 'waf', 'ddos', 'firewall', 'security']),
  svc('gcp')('gcp-iam', 'Identity and Access Management', ['iam', 'identity', 'access', 'permissions', 'roles', 'policy']),
  svc('gcp')('gcp-kms', 'Cloud KMS', ['kms', 'key management', 'encryption', 'keys']),
  svc('gcp')('gcp-secret-manager', 'Secret Manager', ['secrets', 'credentials', 'vault']),
  store('gcp')('gcp-logging', 'Cloud Logging', ['logging', 'logs', 'stackdriver', 'audit log']),
  svc('gcp')('gcp-monitoring', 'Cloud Monitoring', ['monitoring', 'metrics', 'alerts', 'stackdriver', 'observability']),
  store('gcp')('gcp-artifact-registry', 'Artifact Registry', ['registry', 'container registry', 'docker images', 'images', 'packages']),
  svc('gcp')('gcp-cloud-build', 'Cloud Build', ['build', 'ci', 'cd', 'ci/cd', 'pipeline']),
  svc('gcp')('gcp-vertex-ai', 'Vertex AI', ['vertex', 'machine learning', 'ml', 'llm', 'gemini', 'model']),

  brand('cloudflare')('cloudflare', 'Cloudflare', ['cf', 'edge', 'cdn', 'cloud']),
  svc('cloudflare')('cloudflare-cdn', 'Cloudflare CDN', ['cdn', 'cache', 'edge', 'content delivery']),
  svc('cloudflare')('cloudflare-workers', 'Cloudflare Workers', ['workers', 'serverless', 'function', 'edge', 'faas']),
  svc('cloudflare')('cloudflare-pages', 'Cloudflare Pages', ['pages', 'static site', 'hosting', 'jamstack', 'frontend']),
  store('cloudflare')('cloudflare-r2', 'Cloudflare R2', ['r2', 'blob', 'object storage', 'bucket', 'storage', 's3']),
  store('cloudflare')('cloudflare-d1', 'Cloudflare D1', ['d1', 'sqlite', 'sql', 'relational', 'database']),
  store('cloudflare')('cloudflare-kv', 'Cloudflare Workers KV', ['kv', 'workers kv', 'key value', 'cache', 'edge storage']),
  store('cloudflare')('cloudflare-queues', 'Cloudflare Queues', ['queues', 'queue', 'message queue', 'messaging']),
  store('cloudflare')('cloudflare-durable-objects', 'Cloudflare Durable Objects', ['durable objects', 'do', 'stateful', 'actor', 'state']),
  svc('cloudflare')('cloudflare-dns', 'Cloudflare DNS', ['dns', 'domain', 'name resolution']),
  svc('cloudflare')('cloudflare-waf', 'Cloudflare WAF', ['waf', 'web application firewall', 'firewall', 'security']),
  svc('cloudflare')('cloudflare-zero-trust', 'Cloudflare Zero Trust', ['zero trust', 'access', 'ztna', 'sso', 'security']),
  svc('cloudflare')('cloudflare-tunnel', 'Cloudflare Tunnel', ['tunnel', 'cloudflared', 'proxy', 'ingress']),
  svc('cloudflare')('cloudflare-load-balancing', 'Cloudflare Load Balancing', ['load balancer', 'load balancing', 'lb', 'failover']),
  svc('cloudflare')('cloudflare-workers-ai', 'Cloudflare Workers AI', ['workers ai', 'inference', 'llm', 'edge ai', 'model']),

  store('databases')('postgres', 'Postgres', ['postgresql', 'pg', 'sql', 'relational', 'database']),
  store('databases')('mysql', 'MySQL', ['mariadb', 'sql', 'relational', 'database']),
  store('databases')('mongodb', 'MongoDB', ['mongo', 'nosql', 'document', 'database']),
  store('databases')('redis', 'Redis', ['cache', 'key value', 'in-memory', 'database']),
  store('databases')('valkey', 'Valkey', ['redis', 'cache', 'key value', 'in-memory', 'database']),
  store('databases')('keydb', 'KeyDB', ['redis', 'cache', 'key value', 'in-memory', 'database']),
  store('databases')('dragonfly', 'Dragonfly', ['dragonflydb', 'redis', 'cache', 'key value', 'in-memory', 'database']),

  brand('kubernetes')('kubernetes', 'Kubernetes', ['k8s', 'cluster', 'container', 'orchestration']),
  svc('kubernetes')('k8s-pod', 'Pod', ['k8s', 'kubernetes', 'container', 'workload']),
  svc('kubernetes')('k8s-deployment', 'Deployment', ['k8s', 'kubernetes', 'rollout', 'replicas', 'workload']),
  svc('kubernetes')('k8s-statefulset', 'StatefulSet', ['k8s', 'kubernetes', 'sts', 'stateful', 'workload']),
  svc('kubernetes')('k8s-daemonset', 'DaemonSet', ['k8s', 'kubernetes', 'ds', 'per node', 'workload']),
  svc('kubernetes')('k8s-replicaset', 'ReplicaSet', ['k8s', 'kubernetes', 'rs', 'replicas', 'workload']),
  svc('kubernetes')('k8s-job', 'Job', ['k8s', 'kubernetes', 'batch', 'run to completion', 'workload']),
  svc('kubernetes')('k8s-cronjob', 'CronJob', ['k8s', 'kubernetes', 'cron', 'schedule', 'batch', 'workload']),
  svc('kubernetes')('k8s-service', 'Service', ['k8s', 'kubernetes', 'svc', 'clusterip', 'load balancer', 'networking']),
  svc('kubernetes')('k8s-ingress', 'Ingress', ['k8s', 'kubernetes', 'ingress controller', 'route', 'http', 'networking']),
  svc('kubernetes')('k8s-configmap', 'ConfigMap', ['k8s', 'kubernetes', 'cm', 'config', 'configuration', 'settings']),
  svc('kubernetes')('k8s-secret', 'Secret', ['k8s', 'kubernetes', 'credentials', 'password', 'token', 'config']),
  store('kubernetes')('k8s-pv', 'Persistent Volume', ['k8s', 'kubernetes', 'pv', 'volume', 'disk', 'storage']),
  store('kubernetes')('k8s-pvc', 'Persistent Volume Claim', ['k8s', 'kubernetes', 'pvc', 'claim', 'volume', 'storage']),
  svc('kubernetes')('k8s-namespace', 'Namespace', ['k8s', 'kubernetes', 'ns', 'tenant', 'isolation']),
  svc('kubernetes')('k8s-hpa', 'Horizontal Pod Autoscaler', ['k8s', 'kubernetes', 'hpa', 'autoscaling', 'autoscaler', 'scale']),
  svc('kubernetes')('k8s-node', 'Node', ['k8s', 'kubernetes', 'worker', 'machine', 'kubelet']),
  svc('kubernetes')('k8s-control-plane', 'Control Plane', ['k8s', 'kubernetes', 'master', 'api server', 'apiserver', 'scheduler', 'controller manager']),
  svc('kubernetes')('k8s-network-policy', 'Network Policy', ['k8s', 'kubernetes', 'netpol', 'firewall', 'network', 'security']),
  svc('kubernetes')('k8s-service-account', 'Service Account', ['k8s', 'kubernetes', 'sa', 'identity', 'rbac', 'permissions']),

  svc('cncf')('prometheus', 'Prometheus', ['metrics', 'monitoring', 'alerting', 'promql', 'observability']),
  svc('cncf')('envoy', 'Envoy', ['proxy', 'service mesh', 'sidecar', 'load balancer']),
  svc('cncf')('helm', 'Helm', ['helm chart', 'package manager', 'kubernetes', 'k8s', 'release']),
  svc('cncf')('argo', 'Argo', ['argocd', 'argo cd', 'gitops', 'workflows', 'ci/cd', 'deploy']),
  svc('cncf')('flux', 'Flux', ['fluxcd', 'gitops', 'continuous delivery', 'deploy', 'kubernetes', 'k8s']),
  svc('cncf')('istio', 'Istio', ['service mesh', 'mesh', 'sidecar', 'mtls', 'kubernetes', 'k8s']),
  svc('cncf')('linkerd', 'Linkerd', ['service mesh', 'mesh', 'sidecar', 'mtls', 'kubernetes', 'k8s']),
  svc('cncf')('cilium', 'Cilium', ['cni', 'ebpf', 'networking', 'network policy', 'kubernetes', 'k8s']),
  svc('cncf')('containerd', 'containerd', ['container runtime', 'runtime', 'cri', 'docker', 'kubernetes', 'k8s']),
  svc('cncf')('coredns', 'CoreDNS', ['dns', 'name resolution', 'service discovery', 'kubernetes', 'k8s']),
  store('cncf')('etcd', 'etcd', ['key value', 'consensus', 'raft', 'kubernetes', 'k8s', 'database']),
  svc('cncf')('fluentd', 'Fluentd', ['logs', 'logging', 'log forwarder', 'collector', 'observability']),
  svc('cncf')('jaeger', 'Jaeger', ['tracing', 'traces', 'distributed tracing', 'observability']),
  svc('cncf')('opentelemetry', 'OpenTelemetry', ['otel', 'telemetry', 'tracing', 'metrics', 'collector', 'observability']),
  store('cncf')('harbor', 'Harbor', ['registry', 'container registry', 'docker images', 'images']),
  svc('cncf')('keda', 'KEDA', ['autoscaling', 'autoscaler', 'event driven', 'scale to zero', 'kubernetes', 'k8s']),
  svc('cncf')('cert-manager', 'cert-manager', ['certificates', 'tls', 'letsencrypt', 'acme', 'kubernetes', 'k8s']),
  store('cncf')('nats', 'NATS', ['messaging', 'message queue', 'pubsub', 'jetstream', 'queue']),
  svc('cncf')('open-policy-agent', 'Open Policy Agent', ['opa', 'policy', 'rego', 'authorization', 'gatekeeper']),
  svc('cncf')('knative', 'Knative', ['serverless', 'kubernetes', 'k8s', 'functions', 'eventing']),
];

export const ICON_IDS: readonly string[] = ICONS.map(i => i.id);
const BY_ID: Readonly<Record<string, IconSpec>> = Object.fromEntries(ICONS.map(i => [i.id, i]));

export function isIconId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(BY_ID, id);
}

export function iconSpec(id: string): IconSpec | undefined {
  return isIconId(id) ? BY_ID[id] : undefined;
}

/** The kinds that draw an icon; a note is bare text and a chart draws its own card. */
export const ICON_NODE_KINDS: readonly string[] = ['service', 'datastore', 'external', 'boundary'];
export const ICON_KIND_RULE = 'icons go on service, datastore, external and boundary nodes';
export const ARCHITECTURE_ICON_RULE = 'icons are not supported on architecture boards yet';

/** Default size of a placed icon node: the icon above a label, on the 4 px grid. */
export const ICON_NODE_W = 160;
export const ICON_NODE_H = 96;

/** Icon size per node size: 24, 28 or 36 px for s, m and l (spec D7). The client draws
 *  it from ICON_TOP, and the label band starts ICON_GAP below it. */
export function iconPx(size: string): number {
  return size === 's' ? 24 : size === 'l' ? 36 : 28;
}
export const ICON_TOP = 12;
export const ICON_GAP = 6;
/** Where the label band below a node's icon starts. */
export function iconTextTop(size: string): number {
  return ICON_TOP + iconPx(size) + ICON_GAP;
}
