# Amazon Web Services

Amazon Web Services (AWS) is a cloud platform composed of independently operated services for compute, storage, networking, identity, messaging and other capabilities. Its services expose APIs with their own resource models, permissions, quotas and failure semantics. A managed service removes parts of infrastructure operation; the application still determines data ownership, authorization, retry policy and recovery behavior. This collection focuses on serverless compute and event-driven data processing, rather than attempting an inventory of every AWS service. [AWS documentation](https://docs.aws.amazon.com/)

## Accounts, Regions and resources

An **account** is a principal boundary for resource ownership and billing. A **Region** is a geographical service deployment; many resources and quotas are regional. An **Availability Zone** is an isolated location within a Region. Availability across zones, regional replication and multi-account isolation are different properties. Do not infer one from another or assume that a resource with the same name in two Regions contains the same data. [AWS Regions and Availability Zones](https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions-availability-zones.html)

An Amazon Resource Name identifies a resource using a service-specific form beginning `arn:partition:service:region:account-id:resource`. Some fields are absent for particular global resources, and separators in the resource component vary by service. Prefer the ARN returned by a service or provisioning tool over string construction. The account and Region used by an SDK client must agree with the intended resource and credentials. [ARN reference](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference-arns.html)

AWS services have **control-plane operations** that create and configure resources and **data-plane operations** that use them. Creating an SQS queue, for example, differs from publishing or receiving a message. Deployment and runtime permissions can therefore be separated. Event delivery frequently involves a service principal acting on behalf of a source resource, which also requires a destination policy or execution role.

## Service responsibilities

| Service | Main abstraction | Important boundary | Article |
| --- | --- | --- | --- |
| Lambda | Function invocation | Process lifetime and trigger-specific retries | [Lambda and HTTP entry points](lambda-and-api.md) |
| API Gateway | Managed HTTP routing and authorization | Gateway authentication does not authorize every application record | [API entry choices](lambda-and-api.md#api-front-door) |
| DynamoDB | Key-addressed items and indexes | Conditional writes and transactions have a defined atomic scope | [Data modeling](dynamodb.md) |
| DynamoDB Streams | Item change records | Retention and per-item order, not a permanent global log | [Transactions and outbox](dynamodb-outbox.md) |
| SQS | Buffered messages | Visibility is a lease; acknowledgement does not commit external effects | [Queues and consumers](sqs.md) |
| SNS | Topics and subscriptions | Fan-out delivery, policy and retry are per subscription | [SNS and feedback](sns-and-feedback.md) |
| SES | Email submission and feedback | Acceptance, delivery and inbox placement are different outcomes | [SES](ses.md), [deliverability](deliverability.md) |
| S3 | Objects in buckets | Object-level operations do not transact with database writes | [S3](s3.md) |
| CloudFront | Distribution, origins and cache behaviors | Viewer authentication, origin access and caching are separate | [CloudFront](cloudfront.md) |
| Route 53 and ACM | DNS zones, records and certificates | DNS delegation, certificate issuance and service hostname configuration are separate | [Domains and TLS](route53-and-acm.md) |
| EventBridge Scheduler | Persisted future invocations | Delivery retry and time precision differ from a cron process | [Scheduler](scheduler.md) |
| IAM, KMS, Secrets Manager | Authorization, key use and secret lifecycle | A resource permission does not automatically grant key access | [Identity and secrets](iam-and-secrets.md) |
| CloudWatch and CloudTrail | Telemetry and AWS activity records | Infrastructure success can hide record-level failure | [Observability](observability.md) |

The services can be composed in many ways. SNS broadcasts to subscribers; SQS buffers for consumers; Scheduler records a future trigger. Substituting one for another because each “sends a message” changes retention, acknowledgement and recovery behavior. Likewise, an Effect Queue is local memory and does not have SQS durability.

For application credentials at HTTP boundaries, see [bearer-token authentication](http-token-authentication.md). For email engagement events and branded tracking domains, see [SES tracking](ses-engagement-tracking.md). These are reusable integration patterns, with their own access and measurement constraints.

## Reliability across service boundaries

A successful API response describes that API's acknowledgement point. SQS accepting a message says nothing about whether its consumer succeeded; SES returning a message ID says nothing about inbox placement. A client timeout is also ambiguous: the remote service may have completed the request before its response was lost. Retry safety depends on the operation's idempotency contract, not just its HTTP status. [SQS delivery](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html), [SES SendEmail](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html)

Where a state change and message publication must agree, an outbox can commit the state and a durable publication intent together, then relay the intent. It closes the loss window between a database commit and an enqueue, but still permits duplicate publication. Consumers need a stable operation identity and conditional transitions. A database transaction cannot make an arbitrary call to another service atomic. [Transactional outbox](dynamodb-outbox.md)

Concurrency and rate are separate controls. Limiting Lambda environments bounds simultaneous invocations, while a downstream quota may count recipients, operations, bytes or requests per second. Buffer age reveals demand that exceeds processing capacity; buffer depth alone does not show how long work has waited. Recovery paths—including dead-letter queues and replay—must use the same identities and authorization rules as the original path.

## Finding precise documentation with llms.txt

AWS publishes a verified [global `llms.txt`](https://docs.aws.amazon.com/llms.txt) containing service-guide entries. It links both a guide's Markdown landing page and its own `llms.txt`. Read the service-specific index before fetching individual pages; the global file is large and is a directory, not the body of every guide.

| Documentation set | Agent-readable index |
| --- | --- |
| Lambda | [Developer Guide](https://docs.aws.amazon.com/lambda/latest/dg/llms.txt) |
| DynamoDB | [Developer Guide](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/llms.txt) |
| SQS | [Developer Guide](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/llms.txt) |
| SNS | [Developer Guide](https://docs.aws.amazon.com/sns/latest/dg/llms.txt) |
| SES | [Developer Guide](https://docs.aws.amazon.com/ses/latest/dg/llms.txt), [API v2 reference](https://docs.aws.amazon.com/ses/latest/APIReference-V2/llms.txt) |
| S3 | [User Guide](https://docs.aws.amazon.com/AmazonS3/latest/userguide/llms.txt) |
| Scheduler | [User Guide](https://docs.aws.amazon.com/scheduler/latest/UserGuide/llms.txt) |
| IAM | [User Guide](https://docs.aws.amazon.com/IAM/latest/UserGuide/llms.txt) |
| Secrets Manager | [User Guide](https://docs.aws.amazon.com/secretsmanager/latest/userguide/llms.txt) |
| CloudWatch | [User Guide](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/llms.txt) |

The indexes inspected on 2026-09-11 point to `.md` article endpoints. Follow their exact paths: capitalization and guide prefixes matter, and a guessed filename may return 404. Use the API reference for request fields and error codes, the developer guide for behavior, and service quota pages for current constraints. Recheck mutable limits, runtime support, Region availability and pricing before relying on them operationally.

For TypeScript infrastructure that provisions these resources, see [Alchemy](../alchemy/alchemy.md). For typed runtime composition and resource lifetimes, see [Effect](../effect/effect.md). Neither layer changes the AWS guarantees described here.
