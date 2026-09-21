# CloudWatch, CloudTrail and operational diagnosis

[AWS](aws.md) · [Effect instrumentation](../effect/testing-and-observability.md)

CloudWatch collects metrics, logs and alarms; CloudTrail records supported AWS API activity. Application records describe domain operations and their durable outcomes. These sources answer different questions: whether a function ran, which principal changed a resource, and whether an intended operation completed. None is a universal substitute for the others. [CloudWatch concepts](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch_concepts.html), [CloudTrail management events](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/logging-management-events-with-cloudtrail.html)

## Metrics have an identity

A CloudWatch metric is identified by namespace, metric name and dimension combination. Adding a new resource or request identifier as a dimension can create another metric series. Use bounded dimensions such as operation kind and outcome for aggregate telemetry, and keep unbounded correlation IDs in logs or durable records. Choosing a dimension set is therefore both an analysis and a cost decision. [Metric dimensions](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch_concepts.html#Dimension)

Select a statistic appropriate to the quantity. Summing a count differs from averaging a duration, and a latency percentile conveys information an average can hide. Use a period long enough to contain meaningful samples for the workload, and keep numerator and denominator aligned when computing a failure rate. Missing samples are not automatically equivalent to a measured zero.

## Observe the acknowledgement boundaries

| Boundary | Useful signals | What success does not establish |
| --- | --- | --- |
| HTTP handler | Response class, duration, throttles | Completion of asynchronously accepted work |
| SQS consumer | Visible backlog, age, receives, DLQ growth, record outcomes | Every record succeeded merely because the invocation returned |
| Outbox relay | Oldest pending intent, publication outcome, retries | Destination consumer completed the operation |
| SES | Submission outcomes, bounce/complaint feedback, processing lag | Inbox placement or human engagement |
| State reconciliation | Resource failures, drift, unexpected replacement | Application data correctness |

Instrument partial failures and quarantined records separately from invocation errors. A consumer can successfully return `batchItemFailures`, causing selected records to retry while the Lambda invocation is considered successful. Conversely, a top-level failure can repeat records that already completed. Measure the domain acknowledgement point directly. [Lambda metric definitions](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html), [SQS error handling](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html)

## Alarms need interpretation

An alarm combines a metric, statistic, period, threshold, evaluation rule and missing-data behavior. Decide whether missing data means normal inactivity, a monitoring fault or possible service failure. A low-volume queue and a continuously reporting heartbeat need different assumptions. Document the action that a responder can take for the alarm rather than relying only on a notification name. [CloudWatch alarms](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/AlarmThatSendsEmail.html)

Use backlog age to understand latency and count to understand volume; monitor both when either matters. A growing DLQ requires classification and replay controls, not simply an automated purge. When a downstream quota is exhausted, increasing consumer concurrency can worsen retry pressure. Compare demand, processing rate and downstream errors before changing capacity.

## Logs and traces

Use structured fields for operation, outcome, request ID and relevant upstream request ID. Preserve correlation through message metadata when work crosses a process boundary. A transport message ID, tracing identifier and application idempotency key have different meanings; retain the relationship rather than overloading one field for all three.

Exclude secret values, authorization headers, complete signed URLs and unnecessary personal data. Define log retention, access and sampling explicitly. Debug logging proportional to each record can dominate cost during high-volume replay. Trace export should not turn a known successful non-idempotent operation into a retry merely because the telemetry backend is unavailable. [Effect logs and spans](../effect/testing-and-observability.md#logs-and-spans)

## Audit and recovery

CloudTrail management events help explain who created, modified or deleted AWS resources. Data-plane event coverage depends on the service and configured trail/event selectors; do not assume every read or message send is present in the default event history. Application authorization decisions and operation state transitions need their own audit representation if they must be reconstructed later. [CloudTrail management-event scope](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/logging-management-events-with-cloudtrail.html)

During an incident, preserve the original event identity, acknowledgement state and relevant resource versions. Compare application state, queue state and cloud telemetry instead of treating a missing message as proof of success. A database restore or state-file restore cannot reverse an external operation already accepted by another service. Controlled replay must consult current authorization and completed-operation records.

## Cost and documentation

Measure requests, retries, bytes, duration, retention and fan-out when estimating cost. Include logging and metrics, KMS and secret retrieval, networking, backups and secondary indexes in addition to primary compute. An original event can produce multiple notifications, worker attempts and telemetry records, so cost is not necessarily proportional to accepted API calls.

The [CloudWatch `llms.txt`](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/llms.txt) identifies metric, alarm and query guides. Use service-specific metric definitions for exact units and semantics; similarly named metrics can count different events.
