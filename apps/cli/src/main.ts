import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";

import { reporting } from "./Diagnostics.ts";
import { emailer } from "./Emailer.ts";

// The reporter wraps the provisioning too, so a failure building the HTTP client or reading
// configuration is reported like any other. The runner's own reporting stays disabled: it runs
// outside this program's context and can write to stdout, which belongs to the command's result.
Command.run(emailer, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  reporting,
  (program) => NodeRuntime.runMain(program, { disableErrorReporting: true }),
);
