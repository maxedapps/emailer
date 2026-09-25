import { Cause, Console, Effect, Inspectable, Predicate, Runtime } from "effect";

/**
 * Whether a cause is worth telling the operator about.
 *
 * Two are not. An interruption is the operator's own Ctrl-C, and printing a diagnostic for it
 * turns a deliberate stop into what looks like a fault. An error carrying Effect's already-reported
 * marker has been rendered by whoever raised it — the CLI framework's own help and validation
 * output, or a command that printed something more specific than this reporter could.
 */
const shouldReport = (cause: Cause.Cause<unknown>): boolean =>
  !Cause.hasInterruptsOnly(cause) && Runtime.getErrorReported(Cause.squash(cause));

const messageOf = (cause: unknown): string =>
  Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message) ? cause.message : "";

/**
 * A failure's message, then the message of each cause down a chain of `Error`s. Anything else ends
 * the chain: a `ConfigError` is not an `Error`, and its message already includes its cause.
 */
const messages = (cause: unknown): ReadonlyArray<string> => [
  messageOf(cause),
  ...(cause instanceof Error ? messages(cause.cause) : []),
];

/**
 * An expected failure and an unexpected one need different things said about them.
 *
 * An expected failure is a tagged value whose fields *are* the diagnostic — which address was
 * refused, which entity was not found — and a stack trace through the HTTP client says nothing an
 * operator can act on. A contract error's message is empty, so it is inspected. A schema,
 * configuration or transport failure is said in its messages instead: inspected, it is a whole
 * schema tree or an empty cause. A defect is usually a native `Error`, which inspects to an empty
 * object, and the message and stack are the only things that identify it.
 */
const render = (cause: Cause.Cause<unknown>): string => {
  if (!Cause.hasFails(cause)) {
    return Cause.pretty(cause);
  }

  const failure = Cause.squash(cause);

  return messageOf(failure) === ""
    ? Inspectable.toStringUnknown(failure)
    : messages(failure)
        .filter((message) => message !== "")
        .join(": ");
};

/**
 * The one place a failure becomes operator-visible output. It writes to stderr so that stdout
 * stays the command's result and nothing else — a caller piping `emailer contacts get` into `jq`
 * gets JSON or gets nothing.
 *
 * It is deliberately not `NodeRuntime`'s default reporting: the runner reports outside the
 * program's context, which means outside any logger the program provided, and can write to stdout.
 */
const reportCause = (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  shouldReport(cause) ? Console.error(`emailer: ${render(cause)}`) : Effect.void;

/**
 * Wraps the whole command program, service provisioning included, so a failure while building the
 * HTTP client or reading configuration is reported the same way as one from a request. The cause
 * is not changed: the exit code and the failure itself pass through untouched.
 */
export const reporting = <A, E, R>(program: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.tapCause(program, reportCause);
