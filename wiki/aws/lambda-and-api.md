# Lambda and API entry points

[AWS](aws.md) · [Token authentication](http-token-authentication.md) · [CloudFront origins](cloudfront.md) · [MCP HTTP compatibility](../mcp/transports-and-compatibility.md)

Related: [SQS](sqs.md)

## Runtime behavior

Lambda reuses execution environments, so reusable clients belong outside per-request work. Never reuse tenant identity or mutable invocation state globally. Package the clients and dependencies actually used rather than relying on a runtime-bundled SDK version. Alchemy beta.77 supports Node.js 22 and 24 ZIP runtimes. Select a runtime supported by both the deployment provider and dependencies, then test the produced bundle. [AWS best practices](https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html), [Runtime list](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html)

Function timeout must include initialization overhead where applicable, network calls, processing and required cleanup. Keep a deadline margin to record an uncertain outcome and settle the response. Increasing timeout alone can increase duplicate-risk windows and held queue leases. CPU capacity scales with configured memory; benchmark representative compute and I/O workloads rather than minimizing memory by habit.

## Invocation types are different

| Entry | Acknowledgement and retry owner |
| --- | --- |
| HTTP / Function URL / API Gateway | Caller receives response; caller may retry |
| SQS event-source mapping | Lambda polls and deletes successfully processed messages |
| SNS direct Lambda delivery | SNS delivery and Lambda asynchronous invocation each have their own failure handling |
| DynamoDB Streams mapping | Stream checkpoint and mapping retry rules apply |

A Lambda asynchronous DLQ is not the SQS source queue's redrive DLQ. Configure and test the mechanism for the actual invocation type. [SQS invocation behavior](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html), [SNS DLQs](https://docs.aws.amazon.com/sns/latest/dg/sns-dead-letter-queues.html)

## API front door

A Function URL is a simple HTTP entry with `NONE` or `AWS_IAM` auth. Alchemy's `functionUrl: true` creates a public URL; it does not add application authentication. AWS's current IAM model requires both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` permissions for URL access. [Function URL access](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html)

API Gateway HTTP API provides JWT and Lambda authorizers. A Function URL provides a smaller HTTP surface with IAM or application-managed authorization. REST API, HTTP API and Function URLs have different feature sets; REST API usage plans and API-key features cannot be assumed to exist on HTTP API. Compare authentication, routing and traffic controls before choosing an entry point. Resource-level authorization and domain rate limits remain application responsibilities. [HTTP API authorization](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-access-control.html)

For work that exceeds a request deadline, acknowledge only after the job or intent is durable and expose a stable operation ID. Detached promises do not extend Lambda's reliable execution lifetime. A short request handler and a durable consumer have different acknowledgement and retry boundaries.

## Concurrency and networking

Independent functions and concurrency budgets can isolate workloads with different latency and recovery requirements. Sharing a function or account concurrency pool can allow a backlog in one workload to starve another.

Reserved concurrency caps a function's concurrent invocations; per-mapping maximum concurrency caps the queue's contribution. Neither directly enforces a downstream requests-per-second quota. Account for every mapping sharing the function and leave room for control-plane operations. [SQS scaling](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-scaling.html)

Use a VPC only when a dependency requires one. A Lambda attached to private subnets needs a valid path to public AWS APIs through suitable endpoints or NAT; adding a VPC is not itself a security solution and can introduce cost and connectivity failures. Validate DNS and AWS API reachability in the actual stage. [Lambda best practices](https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html)

## Initialization, invocation and shutdown

A standard execution environment passes through initialization, invocation and shutdown phases. Module-level code initializes once for that environment; a handler can then process multiple invocations. Frozen environments may later resume, but neither reuse nor shutdown timing is guaranteed. Keep immutable clients or caches outside the handler while keeping request identity and mutable operation state inside it. [Runtime lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html)

Do not start unawaited work and then rely on the environment to remain running. A Promise-based handler's returned Promise defines its visible completion; process termination can prevent later callbacks and finalizers. Bound downstream request timeouts below the remaining invocation budget so error classification and acknowledgement still have time to complete. Retry safety must account for calls that may have succeeded before timeout.

## Packaging and handler shape

A Node handler export must match the configured handler name, module format and runtime. Package dependencies deliberately, including native dependencies for the target architecture. TypeScript's successful typecheck does not prove that emitted imports resolve or that the bundle contains required assets. Exercise the emitted entry in a compatible runtime before deployment. [Node handler contract](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-handler.html)

A Function URL or API Gateway event, a direct application payload and an SQS batch are different input contracts. Return the shape expected by the invoking integration. A web `Response` object is not automatically an SQS batch response, and a generic JSON result is not automatically a correctly encoded API Gateway response. An adapter must perform the specific conversion, including status, headers, body encoding and error/acknowledgement fields.

Versions and aliases provide stable references to published function revisions. An alias can be moved without changing every caller's target identifier, but permissions and mappings still need the intended qualified or unqualified ARN. Versioning does not migrate database records or roll back external side effects. [Lambda aliases](https://docs.aws.amazon.com/lambda/latest/dg/configuration-aliases.html)

## Follow a failed request across layers

For an HTTP failure, distinguish client validation, gateway authorization, function invocation, handler failure and response encoding. For a queue failure, distinguish permission to poll, message visibility, handler outcome and redrive. For a timeout, inspect downstream latency and concurrency before merely increasing the function limit. For a cold-start failure, inspect module import and configuration acquisition, which can fail before the handler's own logging starts.

Use the [Lambda `llms.txt`](https://docs.aws.amazon.com/lambda/latest/dg/llms.txt) for runtime and trigger-specific guides. Gateway and Lambda limits are separate; a function timeout alone does not establish how long an HTTP client can wait.
