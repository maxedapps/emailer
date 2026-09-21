# IAM, KMS and runtime secrets

[AWS](aws.md) · [Alchemy bindings](../alchemy/runtime-and-bindings.md) · [HTTP token authentication](http-token-authentication.md)

IAM controls which principals may perform AWS actions on which resources. KMS controls use of encryption keys, and Secrets Manager controls storage and rotation of secret values. These systems interact, but one permission does not imply another: being allowed to read a queue, object or secret may still require access to its customer-managed key. [IAM policy evaluation](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html), [KMS key policies](https://docs.aws.amazon.com/kms/latest/developerguide/key-policies.html)

## Identify the acting principal

For every operation, identify the principal that makes the request. A deployment role may create a Lambda and its execution role; the function uses its execution role to access a table; SNS uses a service principal to deliver into SQS. These are separate requests evaluated against different policies. Credentials selected by a local profile do not automatically become the Lambda's runtime credentials.

Temporary role credentials include an access key, secret key and session token and expire with their session. A runtime SDK should use the platform's credential provider rather than baked-in access keys. A CLI client of an application API often needs application credentials rather than direct cloud permissions. Keep deployment and runtime capabilities separate so an application compromise does not inherit infrastructure administration.

## Understand the policy boundaries

| Policy or control | Purpose |
| --- | --- |
| Identity policy | Grants actions to a user or role |
| Role trust policy | Defines who may assume a role |
| Resource policy | Grants or restricts access at a queue, topic, bucket or other resource |
| Permissions boundary | Limits permissions available to an identity; does not independently grant them |
| Organization policies | Bound permitted behavior within organizational scope |
| KMS key policy / grant | Controls use of a particular encryption key |

An explicit deny can override an allow. Effective authorization depends on policy type, principal type and account boundary; do not reduce every case to “the role has an Allow.” Cross-account access and role-session resource grants have additional evaluation rules. When a request fails, inspect all applicable policy layers and request conditions before broadening access. [Evaluation rules](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html)

## Constrain service-to-service access

An SNS subscription does not itself grant permission to send to its SQS destination. A queue policy can grant the SNS service principal `sqs:SendMessage` while restricting the originating topic. This illustrative statement belongs in the destination queue's resource policy:

```json
{
  "Effect": "Allow",
  "Principal": { "Service": "sns.amazonaws.com" },
  "Action": "sqs:SendMessage",
  "Resource": "arn:aws:sqs:eu-west-1:123456789012:events",
  "Condition": {
    "ArnEquals": {
      "aws:SourceArn": "arn:aws:sns:eu-west-1:123456789012:events"
    }
  }
}
```

The resource and source ARNs must identify the actual queue and topic. Use supported source-account or source-ARN conditions when delegating to AWS services to reduce confused-deputy risk; available condition context is integration-specific. Third-party role assumption may instead use an external ID under its own trust contract. Do not blindly copy the same condition shape to every service. [SNS-to-SQS policy](https://docs.aws.amazon.com/sns/latest/dg/subscribe-sqs-queue-to-sns-topic.html), [confused-deputy controls](https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html)

## Key access is separate from data access

A KMS key has its own policy. IAM allows can grant key usage only when the key policy enables the relevant authorization path, and service integrations may additionally require decrypt or data-key operations. Check the principal that actually uses the key rather than granting only the application role. Key policies are regional; a policy on one regional key does not govern a different key with a similar alias. [KMS policy model](https://docs.aws.amazon.com/kms/latest/developerguide/key-policies.html)

When diagnosing encrypted-resource failures, distinguish the data-service action from the KMS action, the key ID from its alias, and encryption configuration from caller authorization. Changing encryption can affect producers and consumers differently. Verify delivery and read paths after a key-policy change.

## Retrieve and rotate secrets

A secret resource stores a value; it does not force a running application to refresh that value. An environment variable captured at deployment remains deployed configuration until changed. Runtime retrieval can observe rotation according to its cache policy. A cached value and a client initialized with that value can have different lifetimes, so refreshing the cache may also require rebuilding or updating the client. [Secrets in Lambda](https://docs.aws.amazon.com/lambda/latest/dg/with-secrets-manager.html)

AWS offers the Parameters and Secrets Lambda extension and code-level parameter utilities. The extension provides a local HTTP interface and caches values; its documented default secret TTL is 300 seconds. That TTL is a performance and rotation tradeoff, not a guaranteed instant refresh. Configure it for the required freshness, handle retrieval failure, and ensure the function has network access to the upstream service. [Retrieval and cache options](https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets_lambda.html)

Not every secret needs a secrets service. A key the system only verifies against itself — a link signing key, a shared secret between two of its own functions — can be minted at deploy time and bound into the environment; see [deploy-time secrets](../alchemy/runtime-and-bindings.md). That trades a retrieval path and rotation machinery for a value that lives in deployment state, so weigh it against who must be able to read the secret and how rotation is meant to happen.

Secret redaction prevents accidental ordinary display but does not encrypt memory, restrict permissions or sanitize every custom serialization. Never put complete credentials, secret values or presigned URLs in normal logs. Validate rotation with both an existing warm client and a newly initialized client, including the period when the previous credential is no longer accepted.

## Documentation lookup

Use the [IAM index](https://docs.aws.amazon.com/IAM/latest/UserGuide/llms.txt) for policy evaluation and condition keys, and the [Secrets Manager index](https://docs.aws.amazon.com/secretsmanager/latest/userguide/llms.txt) for retrieval and rotation. For generated infrastructure policies, inspect the actual Alchemy binding implementation and the resulting resource policy as well as its TypeScript declaration.
