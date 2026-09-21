# Outputs and references

[Alchemy](alchemy.md)

API examples target Alchemy `2.0.0-beta.77` with Effect `4.0.0-rc.112`.

Related: [Lifecycle](lifecycle-and-providers.md)

An `Output<T>` represents a value that deployment will resolve, such as a queue ARN. Passing outputs through resource inputs records dependency edges. Do not coerce an output to a JavaScript string, branch on its truthiness, or use a type assertion to pretend it already resolved. [Inputs and Outputs](https://alchemy.run/infrastructure-as-code/outputs/)

```typescript
import * as AWS from "alchemy/AWS";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";

export const queueSummary = Effect.gen(function* () {
  const queue = yield* AWS.SQS.Queue("Jobs");
  const label = queue.queueArn.pipe(Output.map((arn) => `Queue: ${arn}`));
  return { label, url: queue.queueUrl };
});
```

## Operators

| Task | API | Care point |
| --- | --- | --- |
| Transform a resolved value | `Output.map` | Keep transformations deterministic |
| Combine values | `Output.all(a, b)` | Preserves dependency relationships |
| Interpolate text | `Output.interpolate` tagged template | Ordinary interpolation does not provide equivalent tracking |
| Wrap a constant | `Output.literal` | Useful where an Output-shaped value is required |
| Execute an effectful transformation | `Output.mapEffect` | Its effects may occur during evaluation; not an application job |
| Plan-time lookup | `Output.fromEffect` | Treat lookup freshness and failures explicitly |

Only disclose non-secret Stack outputs. A typed output is not inherently safe for logs. [Output API and evaluation](https://alchemy.run/infrastructure-as-code/outputs/)

## Cross-stack and cross-stage references

A resource `.ref(id, { stack, stage })` reads persisted upstream state. It does not provision the upstream resource or take ownership of it. Missing targets fail with `InvalidReferenceError`. Omitted stack/stage values use the current context, which is convenient but can accidentally address a nonexistent preview stage. [References](https://alchemy.run/infrastructure-as-code/references/)

Reference lifecycle considerations:

- Deploy owners before consumers and destroy consumers before owners.
- Destroying a retained owner drops its state row while the cloud object lives on. Every borrower **plan and deploy** then fails with `InvalidReferenceError` until the owner is redeployed. A borrower's **destroy** still works: `Plan.destroy` evaluates an empty desired state and resolves no references. Redeploying the owner re-adopts through unchanged stack/stage/logical-id tags when the provider tags ownership. [Plan.destroy](https://unpkg.com/alchemy@2.0.0-beta.77/src/Plan.ts), [References](https://alchemy.run/infrastructure-as-code/references/)
- A reference can be passed into an AWS binding during construction (`SendEmail(ref, configurationSet)`). Construction and plan-time resolution are demonstrated; deploy, the IAM grant and a verifying send were confirmed against beta.77. The References page says a reference can be passed "anywhere the real thing is accepted" but shows no AWS-binding example. [References](https://alchemy.run/infrastructure-as-code/references/), [SendEmail](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/SES/SendEmail.ts)
- Reference attributes used as resource inputs or through `Output.map` resolve from upstream state during deployment evaluation. Lambda-bound runtime accessors are different: beta.77 reads their values through `process.env`, so executing one inside the effectful constructor on the deploy machine can yield `undefined` before the deployed binding environment exists. Preserve the attribute as an Output for deployment composition, or evaluate the bound accessor at runtime. Use independently configured input only when a construction-time check actually requires it. [Plan reference resolution](https://unpkg.com/alchemy@2.0.0-beta.77/src/Plan.ts), [Output evaluation](https://unpkg.com/alchemy@2.0.0-beta.77/src/Output.ts), [Lambda Function env](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/Lambda/Function.ts)
- Use references to share infrastructure deliberately; a reference to production data can bypass intended preview isolation.
- References expose the upstream's last persisted outputs, not a live health check or a continuously updated service-discovery stream.
- A downstream deploy must run again after a meaningful upstream output change.
- Avoid circular cross-stack deployment dependencies. Runtime binding cycle support does not automatically solve them.

Use a typed Stack handle when another package needs a whole public output contract. Prefer a resource reference when it needs one existing resource. Expose identifiers needed by clients in a small generated configuration file or API discovery route; avoid making client libraries import the provisioning entry point. [Stack references](https://alchemy.run/infrastructure-as-code/stack/), [File layout](https://alchemy.run/project-structure/file-layout/)

## Resolve values without losing the graph

Choose an Output operator according to the transformation. A pure label or URL transformation belongs in `Output.map`; several attributes that must resolve together belong in `Output.all`. `Output.interpolate` retains dependency-aware interpolation. An ordinary template string evaluates immediately against the wrapper object, so it cannot provide the same deferred resolution semantics.

Output transformations are part of deployment evaluation. Keep them deterministic and avoid using `mapEffect` as an implicit place to send notifications or write application records. If a transformation fails, the dependent resource cannot obtain its input; hiding the failure with a guessed constant can create a resource pointed at the wrong destination. An unresolved value is not an empty value. [Output semantics](https://alchemy.run/infrastructure-as-code/outputs/)

A reference also has a freshness boundary. Consider a producer Stack that publishes a service URL and a consumer Stack that embeds that URL in deployed configuration. Updating the producer changes persisted output, but the consumer's already deployed environment still contains its old value until it is reconciled. Cross-stack references do not create a background subscription that refreshes running consumers.

## Diagnose dependency and reference failures

| Symptom | Likely distinction to inspect |
| --- | --- |
| String contains an object representation | Immediate string coercion instead of Output transformation |
| Referenced object cannot be found | Stack/stage/backend mismatch, missing upstream deployment, or changed logical identity |
| Consumer still uses an old identifier | Persisted reference changed but consumer was not redeployed |
| Plan reports a cycle | Resource input dependencies or cross-stack lifecycle form a cycle |
| Preview can access production data | Reference selection bypasses the intended environment boundary |

For each dependency, identify its owner, the point at which its value becomes available, and what must redeploy when it changes. A cycle in these relationships cannot be repaired by casting an Output to a plain value. [Reference behavior](https://alchemy.run/infrastructure-as-code/references/)
