# ADR-0044: A draft's images load only from absolute https URLs

- Status: Proposed
- Date: 2026-11-24
- Authority: Task 4684. The analysis (artifact `emailer-4684-image-hosting`) proposed refusing image paths that break in every inbox, at draft save. Max chose "Build it" on 2026-11-24. Image hosting stays out of emailer: the launch emails' images are hosted elsewhere (task 2760).
- Amends: [ADR-0019](0019-markdown-campaign-bodies.md), consequence "Images must be absolute https URLs": no longer advice, the API enforces it.
- Plan: [0044-images-only-from-absolute-https-urls.plan.md](0044-images-only-from-absolute-https-urls.plan.md)

## Context

- **emailer hosts no images.** A copy references them by URL. The CLI renders a Markdown image's `href` into `src` verbatim (`apps/cli/src/Markdown.ts`), and hand-written HTML or an API client can put anything there.
- **A path without a host breaks silently.** `![](hero.png)` is stored, previewed (as broken) and mailed to every recipient as a broken image. Until now the README only asked for absolute `https://` URLs.
- **Other sources fail too:** Gmail blocks `data:` images, emailer sends no attachments for `cid:` to name, `http:` images are blocked or flagged by several clients, and a `src` that a Liquid tag decides holds a value nobody can check before it is sent.
- **Every stored body passes a save.** `create`, `update` and `setVariant` each run `validateParts`, which already refuses a body without the unsubscribe link or the postal address with a 422 `InvalidTemplate`. `compileCopy` reparses the stored copy at send, test, preview, check and on every dispatcher slice.

## Decision

- **`validateParts` refuses an HTML part whose `<img>` has a `src` that does not start with `https://`** (case-insensitive). That covers relative and local paths, `file:`, `http:`, protocol-relative `//`, `data:`, `cid:`, an empty `src`, and a `src` that starts with a Liquid tag. A Liquid value after the scheme (`https://cdn.example.com/{{ contact.plan }}.png`) passes.
- **The refusal is the existing `InvalidTemplate`**, with `part: "html"`, a reason quoting the value (`image "hero.png" must be an absolute https:// URL`), and the line and column of its `<img` tag. The CLI already prints it. The quoted value lets a Markdown author find the image in the source file, whose lines differ from the rendered HTML's.
- **Only the save checks.** `compileCopy` does not, so the dispatcher, test sends, previews and checks run exactly as before.
- **A regex finds the tags,** as the CLI's text rendering does for raw HTML. Only `<img src>` is checked, because it is what the Markdown renderer emits and what operator HTML uses. `srcset`, CSS `url()` and VML images are not checked.

## Alternatives considered

1. **Keep the README advice** (no change). Free, and leaves a broken image to be found in the inbox.
2. **Check in the CLI while rendering Markdown.** It could name the Markdown file and line, but misses hand-written `--html`, variants written by hand and every other API client. The API has to hold the rule anyway. Doing both would duplicate it.
3. **Check at test send or preview.** Both are optional, and the broken body is already stored by then.
4. **Check at campaign start or in the dispatcher.** The latest point: a scheduled campaign would fail unattended at its time, and the dispatcher would pay the check on every slice.
5. **An HTML parser** (`htmlparser2`, `parse5`). Exact on every attribute form, but a new dependency in the API bundle adds cold-start weight for operator-written HTML that a tag regex reads correctly.
6. **Hosting images in emailer** (S3 + CloudFront, R2). Compared in the analysis. Not needed for the current sends, and a separate decision.

## Cost

- One regex pass over at most 256 KiB of HTML in the API Lambda, on create, update and setVariant only, beside the Liquid parse that already runs. Well under a millisecond of the API's 512 MB function.
- DynamoDB, SQS, Lambda invocations and CloudWatch Logs: no change. A refusal is a business error that writes no error log.
- The sending path is untouched. Steady-state change: $0.

## Consequences

- A draft whose HTML has a hostless image is refused at save, with the value and its place named.
- An image whose `src` a Liquid tag decides entirely is refused. Personalised images keep a literal `https://` scheme ahead of the Liquid value.
- A commented-out `<img>` with a hostless `src` is refused too. It is mailed as part of the HTML.
- Drafts stored before this change are not rechecked. emailer is not in production.

## Confirmation

- Unit tests (`sending/Templates.test.ts`): each refused form, with its reason, line and column, and accepted https images with Liquid after the host. `campaigns/Campaigns.test.ts` already pins that create, update and setVariant refuse a part `validateParts` refuses.
- Hand check on a test stage through the CLI: `campaigns create --markdown` with a local image is refused, and with an https image it is accepted. `campaigns update` and `variants set` refuse a local image the same way.
- Landing gate on the merged result.
