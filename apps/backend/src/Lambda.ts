import { Stack } from "alchemy";
import * as AWS from "alchemy/AWS";
import { Duration, Effect } from "effect";

const logRetention = Duration.days(7);

/**
 * What every function in the stack shares: a stage-scoped name, the runtime and architecture, and
 * its own log group with bounded retention, declared as `<id>Logs`. Each function keeps its
 * `main: import.meta.url`, because that is what points the bundler at its module.
 */
export const lambdaBasics = (id: string, name: string) =>
  Effect.gen(function* () {
    const { stage } = yield* Stack;
    const functionName = `emailer-${stage}-${name}`;

    const logGroup = yield* AWS.Logs.LogGroup(`${id}Logs`, {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: logRetention,
    });

    return {
      functionName,
      runtime: "nodejs24.x",
      architecture: "arm64",
      logGroupName: logGroup.logGroupName,
    } as const;
  });
