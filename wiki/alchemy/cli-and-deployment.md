# CLI, planning and deployment

[Alchemy](alchemy.md) · [State and credentials](environments-and-state.md) · [Resource lifecycle](lifecycle-and-providers.md)

Commands and implementation details target Alchemy `2.0.0-beta.79`. The CLI loads a TypeScript Stack entry, constructs its desired graph, and uses the configured state and providers. The live site can show a different command map or omit options present in the shipped package; the commands below follow beta.79. [Deploy/plan source](https://unpkg.com/alchemy@2.0.0-beta.79/src/Cli/commands/deploy.ts), [state command source](https://unpkg.com/alchemy@2.0.0-beta.79/src/Cli/commands/state.ts)

A plan is an evaluation of that program: arbitrary JavaScript side effects and backend initialization can still occur even though resource changes are not applied. [CLI reference](https://alchemy.run/cli/), [plan](https://alchemy.run/cli/plan/)

## Select the deployment identity

The default entry is `alchemy.run.ts`; `--config` selects another existing file. Pass an explicit `--stage` for reproducible automation. In beta.79, the fallback is `ALCHEMY_STAGE`, then `live_$USER` for ordinary deployment commands; `dev` uses `dev_$USER`. `$STAGE` is not a substitute. `--profile` selects the Alchemy credential profile, independently of the Stack's name and state location. [Exact stage flags](https://unpkg.com/alchemy@2.0.0-beta.79/src/Cli/commands/flags.ts)

Examples using an already installed local CLI:

```sh
pnpm exec alchemy plan --config alchemy.run.ts --stage sandbox
pnpm exec alchemy deploy --config alchemy.run.ts --stage sandbox
pnpm exec alchemy state list
pnpm exec alchemy state list ExampleStack
pnpm exec alchemy state read ExampleStack/sandbox/Jobs
```

These commands illustrate different operations, not a sequence to execute without context. `plan` and `deploy` target the configured backend; `state read` examines persisted records rather than live cloud configuration. State paths are Stack/stage/resource paths, so use the names returned by `state list` rather than guessing them. A secret-bearing state record needs the same handling as other deployment credentials.

## Interpret a plan

Creation means there is no managed instance corresponding to the desired logical identity. An update changes a resource in place where the provider permits it. Replacement creates another physical generation or performs delete-before-create when required. Deletion removes a managed declaration according to its removal policy. A no-op means the planner found no required change under its comparison rules; it is not a complete application health assessment.

`--detailed` shows declared property differences, and the example above omits it deliberately. The before side is persisted declaration state, not a fresh cloud snapshot. Deferred values may remain unresolved until apply. Redaction is the property's own declaration, so a value the Stack did not mark as secret prints in full — an API token read from configuration and passed through prints to the terminal and to whatever collects the output. Add the flag to investigate a specific unexpected change, not as a habit. To investigate an unexpected create or delete, compare logical IDs, namespaces, stage, backend and previous records before changing physical resources. [Property diff implementation](https://unpkg.com/alchemy@2.0.0-beta.79/src/Cli/PropertyDiff.ts)

## Apply, repeat and recover

A successful deployment reconciles desired objects and saves outputs for future runs. Running the same code again normally reuses unchanged resources, but a changed Action input or forced update can repeat deployment work. A failure can leave both successful changes and unfinished operations. Fix the underlying error and reconcile from observed state; do not assume the entire deployment rolled back.

CLI approval behavior depends on the terminal and options. `--yes` permits applying without the interactive prompt; `--no-input` prevents the CLI from waiting for input. These are operational controls for automation, not safeguards against targeting the wrong account. CI should also serialize writers for the same Stack/stage and provide temporary credentials with the required backend permissions. [Deploy options](https://alchemy.run/cli/deploy/), [CLI noninteractive behavior](https://alchemy.run/cli/)

When state and the cloud disagree, distinguish three cases: wrong deployment identity, out-of-band drift, and an interrupted reconciliation. `drift` observes supported live resources and can report divergence; any repair behavior depends on provider observation support. State deletion forgets tracking and does not delete the physical object. It should not be used as a routine way to clear an error because recovery depends on discovery and ownership evidence. [Drift](https://alchemy.run/cli/drift/), [state inspection](https://alchemy.run/cli/inspecting-state/)

## Adoption and ownership

When a provider can read a resource before creation, it can report absence, an already-owned resource, or an existing foreign resource. An already-owned object can be recovered without broad adoption permission. A foreign object normally produces an ownership conflict; `--adopt` explicitly permits takeover across the deployment. In beta.79 adoption can also be scoped to one resource with `AdoptPolicy.adopt()` on that declaration; the live docs still describe wrapping the deploy. Providers differ in how they establish ownership, so resource name similarity alone is insufficient. [Adoption rules](https://alchemy.run/cli/adopting-resources/), [AdoptPolicy source](https://unpkg.com/alchemy@2.0.0-beta.79/src/AdoptPolicy.ts)

Before adoption, identify the existing owner, saved data, immutable properties and intended removal policy. A later reconciliation may change configuration after adoption. Adoption is neither a data migration nor a universal import mechanism for every provider.

## Development and destruction

`alchemy dev` is a development loop, not a promise of a cloud-free emulator. Local runtime support differs across providers, and declarations can still provision live resources. Keep its stage identity explicit and inspect provider support before assuming that local logs imply local storage. [Development mode](https://alchemy.run/cli/dev/)

`destroy` acts on the managed Stack/stage and its recorded dependency graph. Retained resources can survive while tracking records disappear. Provider-wide destructive commands have a broader scope and must not be treated as equivalent to ordinary Stack cleanup. Before removing a state backend or deployment role, account for every managed resource whose cleanup still depends on it. [Resource removal](lifecycle-and-providers.md#plan-and-reconcile)
