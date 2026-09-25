import * as AWS from "alchemy/AWS";
import type { Layer } from "effect";

import type { StackServices } from "alchemy";

type AwsProviders = Layer.Success<ReturnType<typeof AWS.providers>>;

/**
 * The AWS providers every stack deploys with. `AWS.providers()` is typed with `any` requirements
 * in Alchemy beta.79; naming what it actually requires keeps that `any` out of every layer built
 * from it.
 */
// oxlint-disable-next-line typescript/no-unsafe-assignment
export const awsProviders: Layer.Layer<AwsProviders, never, StackServices> = AWS.providers();
