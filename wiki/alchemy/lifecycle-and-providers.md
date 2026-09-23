# Lifecycle, renaming, and providers

[Alchemy](alchemy.md)

API examples target Alchemy `2.0.0-beta.79` with Effect `4.0.0-rc.117`.

Related: [State](environments-and-state.md)

## Plan and reconcile

Alchemy classifies resources as create, update, replace, delete or no-op. A v2 provider implements `reconcile` to converge both new and existing objects, plus `delete`; optional hooks include `read`, `diff` and `precreate`. Persisted intermediate states support resuming an interrupted deployment. This is not a cross-service transaction or automatic rollback of every successful cloud call. [Resource lifecycle](https://alchemy.run/infrastructure-as-code/resource-lifecycle/), [Providers](https://alchemy.run/infrastructure-as-code/provider/)

A replacement generally creates another generation and retargets dependents before deleting the old one. A provider can request deletion first for uniqueness constraints. Neither sequence migrates DynamoDB records, queued work, identities or application state automatically. An apparently clean resource replacement can still lose data or interrupt application operations.

For durable tables and object-storage buckets, deliberately choose retention, backup and migration behavior. A `retain` policy skips physical deletion but removes Alchemy's state row: the surviving object is no longer tracked by that row. Apply retention in a prior successful deployment before removing its declaration. Retention is not a backup and does not prevent other AWS principals from deleting the resource. [Removal policy](https://alchemy.run/infrastructure-as-code/resource-lifecycle/#removal-policy)

## Rename safely

Moving a file or changing a TypeScript variable leaves a logical ID intact. Changing the logical ID normally creates a new identity; declare the migration with `Alchemy.renamedFrom` when the physical object must survive.

```typescript
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";

export const Jobs = AWS.SQS.Queue("Jobs").pipe(
  Alchemy.renamedFrom("LegacyJobs"),
);
```

Former IDs are namespace-relative; use `{ fqn: "OldNamespace/LegacyJobs" }` when moving between namespaces. Keep aliases so stages that have not upgraded can migrate later. Conflicting claims fail; exchanging two live IDs requires a temporary ID across deployments. Review the plan for actual create/delete operations before accepting a rename. [Renaming resources](https://alchemy.run/infrastructure-as-code/renaming/)

## Writing a missing provider

Prefer an existing resource or a runtime AWS SDK operation before adding a provider. If a persistent infrastructure object is missing, follow the versioned `Resource` and `Provider` contracts; avoid transplanting v1 `create`/`update` implementations.

| Hook | Responsibility |
| --- | --- |
| `read` | Discover existing attributes and ownership; distinguish missing from foreign-owned |
| `diff` | Decide update versus replacement; handle unresolved inputs conservatively |
| `reconcile` | Observe live state, ensure existence, synchronize mutable settings, return accurate attributes |
| `delete` | Delete owned state idempotently; already missing is success |
| `precreate` | Reserve identity/stub when the resource supports cyclic bindings |

`reconcile` receives desired `news`, previous `olds`, current `output`, and bindings. Adoption can supply an output with no old props. Read the cloud rather than assuming old inputs describe reality. Use stable names or remote idempotency tokens, bounded eventual-consistency retries, explicit readiness checks and exhaustive pagination. Authorization/validation failures must not become infinite retries. [Custom provider walkthrough](https://alchemy.run/infrastructure-as-code/custom-provider/)

Validate a provider with: create, repeated reconcile, update, partial-create recovery, adoption, foreign ownership rejection, replacement, delete twice, and final cloud inventory. Side-effect-only Actions cannot substitute for these lifecycle guarantees.

## Implement a provider as a convergent state machine

Start with a globally unique resource type string, explicit props and attribute interfaces, and a `Resource` constructor. Register the implementation with `Provider.succeed` or an effectful provider Layer. The provider's resource type must match the declaration's lookup key; a class or file with a similar name does not register an implementation automatically. [Provider authoring](https://alchemy.run/infrastructure-as-code/custom-provider/)

Treat reconciliation as observe → decide → mutate → observe readiness → return attributes. Creation, adoption and update enter the same convergence logic from different initial conditions. `olds` may be absent during adoption even when `output` describes an existing object. If a remote create succeeded before a timeout, a stable identifier or provider idempotency token should let the next reconciliation discover that object instead of creating another.

Separate not-found, authorization, validation, conflict and transient transport failures. A forbidden read is not evidence that a resource is absent. An asynchronous cloud update needs a readiness check before dependents receive attributes that imply it is usable. Deletion should accept an already-absent object and handle dependencies or asynchronous termination explicitly.

Where enumeration is implemented, paginate `list` and return accurate live-resource identity. Beta.79's helper supplies an empty default for omitted listing; that permits construction but cannot discover real inventory. Broad inventory or cleanup operations are only as complete as each provider's listing implementation. [Provider helper source](https://unpkg.com/alchemy@2.0.0-beta.79/src/Provider.ts)

For a replacement, ask two distinct questions: can the cloud mutate this property in place, and how does existing application data move? A provider can correctly replace a table while leaving data migration entirely unresolved. Likewise, retention preserves a physical object but changes its management relationship. Review both cloud identity and data lifecycle before relying on a plan's classification.

## Partial deployment recovery

Pause affected consumers if a partially applied deployment could corrupt data or perform invalid external operations. Preserve state and logs, inspect the cloud's actual generations and permissions, then rerun the same desired version or apply a targeted repair. Do not erase state to make the plan green. Restoring an old state file alone does not undo remote changes, and re-running a deployment can re-run Actions. [Recovery semantics](https://alchemy.run/infrastructure-as-code/resource-lifecycle/)
