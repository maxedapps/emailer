/**
 * `emailer/flaky-skips` (ADR-0035): a test is skipped only in the shared self-expiring form,
 * `it.skipIf(vi.getRealSystemTime() < Date.parse("<until>"))(…)` marked
 * `// flaky: task-<N> until <until>` on its line or the line above, at most 14 days ahead.
 */
import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const marker = /flaky: task-\d+ until (\d{4}-\d{2}-\d{2})\b/;

const date = /^\d{4}-\d{2}-\d{2}$/;

const day = 86_400_000;

const maxDays = 14;

const isMember = (node: ESTree.Node, object: string, property: string) =>
  node.type === "MemberExpression" &&
  !node.computed &&
  node.object.type === "Identifier" &&
  node.object.name === object &&
  node.property.type === "Identifier" &&
  node.property.name === property;

const calledProperty = (node: ESTree.CallExpression) =>
  node.callee.type === "MemberExpression" &&
  !node.callee.computed &&
  node.callee.property.type === "Identifier"
    ? node.callee.property.name
    : undefined;

/** The date of `vi.getRealSystemTime() < Date.parse("<date>")`, or none for any other condition. */
const untilDate = (condition: ESTree.Node | undefined) => {
  if (
    condition?.type !== "BinaryExpression" ||
    condition.operator !== "<" ||
    condition.left.type !== "CallExpression" ||
    condition.left.arguments.length > 0 ||
    !isMember(condition.left.callee, "vi", "getRealSystemTime") ||
    condition.right.type !== "CallExpression" ||
    !isMember(condition.right.callee, "Date", "parse")
  ) {
    return undefined;
  }

  const [until] = condition.right.arguments;

  return until?.type === "Literal" && date.test(String(until.value))
    ? String(until.value)
    : undefined;
};

const isSkipOption = (property: ESTree.Node) =>
  property.type === "Property" &&
  ((property.key.type === "Identifier" && property.key.name === "skip") ||
    (property.key.type === "Literal" && property.key.value === "skip"));

export const flakySkipsRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Allow only self-expiring, marked skips of flaky tests (ADR-0035)." },
    messages: {
      permanent:
        'Skip a flaky test only until a date: `it.skipIf(vi.getRealSystemTime() < Date.parse("<until>"))(…) // flaky: task-<N> until <until>`.',
      condition:
        'A skip condition must be exactly `vi.getRealSystemTime() < Date.parse("<YYYY-MM-DD>")`, so the test runs again on that day.',
      marker:
        "Mark the skip with `// flaky: task-<N> until {{until}}` on its line or the line above.",
      tooLate: "Skip for at most 14 days: {{until}} is after {{latest}}.",
    },
  },
  createOnce(context) {
    const markedUntil = (line: number) =>
      context.sourceCode
        .getAllComments()
        .filter((comment) => comment.loc.start.line === line || comment.loc.start.line === line - 1)
        .map((comment) => marker.exec(comment.value)?.[1])
        .find((until) => until !== undefined);

    return {
      CallExpression(node) {
        for (const argument of node.arguments) {
          if (argument.type === "ObjectExpression") {
            for (const property of argument.properties.filter(isSkipOption)) {
              context.report({ node: property, messageId: "permanent" });
            }
          }
        }

        const property = calledProperty(node);

        // `runIf` skips on the opposite condition, so it would skip without a date as well.
        if (property === "skip" || property === "runIf") {
          return context.report({ node, messageId: "permanent" });
        }

        if (property !== "skipIf") {
          return;
        }

        const until = untilDate(node.arguments[0]);

        if (until === undefined) {
          return context.report({ node, messageId: "condition" });
        }

        if (markedUntil(node.loc.start.line) !== until) {
          return context.report({ node, messageId: "marker", data: { until } });
        }

        const latest = new Date((Math.floor(Date.now() / day) + maxDays) * day)
          .toISOString()
          .slice(0, 10);

        if (until > latest) {
          context.report({ node, messageId: "tooLate", data: { until, latest } });
        }
      },
    };
  },
});
