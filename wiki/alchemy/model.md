# Stacks, resources, and actions

[Alchemy](alchemy.md)

API examples target Alchemy `2.0.0-beta.79` with Effect `4.0.0-rc.117`.

Alchemy v2 describes infrastructure with Effect programs. A declaration constructs an Effect; yielding a resource records it in the desired graph. The deployment engine subsequently plans and reconciles cloud objects. Arbitrary side effects you add to the program are still ordinary executable code, so keep graph construction free of application writes. [Alchemy model](https://alchemy.run/what-is-alchemy/), [Resources](https://alchemy.run/infrastructure-as-code/resource/)

## Stack composition

A Stack supplies the name, provider Layer, state Layer, and program returning outputs. Keep those four responsibilities at the composition root. Both provider and state choices should be explicit; the AWS backend does not need Cloudflare state.

```typescript
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "ExampleStack",
  { providers: AWS.providers(), state: AWS.state() },
  Effect.gen(function* () {
    const jobs = yield* AWS.SQS.Queue("Jobs");
    return { queueUrl: jobs.queueUrl };
  }),
);
```

This minimal declaration omits workload-dependent queue settings such as retention and visibility timeout; see [SQS configuration](../aws/sqs.md). A returned queue URL is a lazy output until deployment resolves it. [Stacks](https://alchemy.run/infrastructure-as-code/stack/), [AWS Lambda setup](https://alchemy.run/aws/compute/lambda/)

## Read a declaration from the outside in

In the example, `AWS.providers()` supplies reconciliation implementations and `AWS.state()` supplies persistence. The generator is the desired-state program. Yielding `AWS.SQS.Queue("Jobs")` registers a resource under its logical identity; returning `queueUrl` exposes an output contract after deployment. None of these names is an application queue message or a runtime task identifier.

A declaration can be exported from a resource module and yielded by several dependent declarations. Sharing that declaration preserves one infrastructure identity. Creating resources from request data, timestamps or unbounded input collections instead produces an unstable or continually growing desired graph. Use deterministic inputs and logical IDs for infrastructure; reserve dynamic records for runtime APIs.

A resource's input props describe desired configuration. Its output attributes describe resolved identity or observed properties. Those types need not match: the cloud might generate a name, URL, revision or verification token. An output can be passed directly to another declaration without awaiting a cloud API manually. See [outputs](outputs-and-references.md) for transformation and dependency tracking.

## Identity and composition

A resource has a logical ID, input properties, and output attributes. State addresses also include Stack, stage, and namespace. Keep logical IDs stable across source-file and variable renames. Export shared declarations instead of declaring independent resources under guessed physical names. Resource registration is keyed by fully qualified identity; reusing a declaration is different from giving conflicting declarations the same ID.

Infrastructure resource ownership and application data ownership have different lifecycles. Tables, queues and configuration sets are typical infrastructure resources. Frequently changing user records and transaction state generally belong behind runtime APIs. If the same object is managed through both IaC and runtime writes, reconciliation can overwrite runtime changes. The existence of a provider resource, such as SES `Contact`, does not resolve that ownership conflict. [Resources](https://alchemy.run/infrastructure-as-code/resource/), [SES resources](https://alchemy.run/aws/email/sending/)

## Actions

An Action is deploy-time work whose inputs determine whether it runs. Alchemy hashes resolved input and persists the result; unchanged input skips the action, while changed input or force causes another run. Removing an Action drops its state without calling a resource deletion method. It is suitable for an idempotent schema migration or setup task; it does not provide a durable runtime job queue or a transaction ledger.

Action execution can restart after failure. Include migration/version information in inputs, and make the body safe when previous side effects succeeded but result persistence did not. “Skipped on the next successful deploy” does not mean “exactly once.” [Actions](https://alchemy.run/infrastructure-as-code/action/)

### Make Action inputs express the work's version

An Action's saved result is reusable only relative to the input used to decide whether it runs. Include an explicit operation revision when the body changes semantically; editing its implementation is not a substitute for changing the resolved input contract. Avoid including a timestamp merely to force a run on every deployment.

For example, an idempotent migration Action can take a database identifier and migration revision, inspect whether that revision is already applied, and return a durable revision marker. If the process crashes after the migration but before saving the Action result, the next execution can observe that marker and finish without applying the migration twice. The cloud-side marker and idempotency policy belong to the Action implementation; Alchemy's saved input hash alone cannot close that crash window. [Action lifecycle and inputs](https://alchemy.run/infrastructure-as-code/action/)

If work requires cleanup when removed, periodic runtime execution, or a user-visible retry queue, an Action lacks the necessary lifecycle. Use a Resource for owned infrastructure and an application or durable orchestration mechanism for runtime work. [CLI execution](cli-and-deployment.md)

## Choose the right unit

| Need | Unit |
| --- | --- |
| Create/manage/delete a cloud object | Resource and provider |
| Idempotent work as part of deployment | Action |
| Handle an API request or queue delivery | Lambda runtime handler |
| Share implementation and dependencies | Effect service and Layer |
| Preserve work through a crash | DynamoDB record, SQS message, or durable orchestration |

Stack boundaries determine deployment ownership, cadence and lifecycle coupling. A single Stack keeps dependency ordering within one graph; multiple Stacks permit independent deployment but require explicit cross-stack ordering and reference management. [Monorepo](https://alchemy.run/project-structure/monorepo/)
