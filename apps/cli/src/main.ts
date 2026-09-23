import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";

import { reporting } from "./Diagnostics.ts";
import { emailer } from "./Emailer.ts";
import { stderrTerminal } from "./Terminal.ts";

// NodeServices' own terminal writes to stdout; the stderr one replaces it.
const services = stderrTerminal.pipe(Layer.provideMerge(NodeServices.layer));

// The reporter wraps the provisioning too, so a failure building the HTTP client or reading
// configuration is reported like any other. The runner's own reporting stays disabled: it runs
// outside this program's context and can write to stdout, which belongs to the command's result.
Command.run(emailer, { version: "0.0.0" }).pipe(Effect.provide(services), reporting, (program) =>
  NodeRuntime.runMain(program, { disableErrorReporting: true }),
);
