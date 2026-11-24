# Plan: images only from absolute https URLs (ADR-0044)

Task 4684. [ADR-0044](0044-images-only-from-absolute-https-urls.md) holds the design and its cost.

## Goal

- Saving a draft (create, update, setVariant) refuses an HTML part whose `<img src>` does not start with `https://`, naming the value and its place.

## Non-goals

- Hosting or uploading images. Checking `srcset`, CSS `url()` or VML images. Rechecking stored drafts or checking at send time.

## Tasks

1. **Check** (`sending/Templates.ts`): `refuseUnhostedImages`, called by `validateParts` for the HTML part after it parses. Unit: `Templates.test.ts` (each refused form with its reason, line and column; https images, uppercase, and Liquid after the host accepted).
2. **Docs**: README's Markdown note says the API refuses other image sources. ADR-0019 notes the amendment.
3. **Hand check** on a fresh test stage through the CLI: create with a local image refused, with an https image accepted; update and `variants set` with a local image refused. Then destroy the stage.

## Evidence

- The CLI's refusal and acceptance as printed, plus the key files and snippets.

## Hand check

On a fresh test stage, through the CLI with a Markdown file holding `![x](hero.png)`:

- `campaigns create --markdown` was refused: `InvalidTemplate`, part `html`, `image "hero.png" must be an absolute https:// URL`, line 20, column 29; the same body posted to the API answered 422;
- the same file with `![x](https://example.com/images/hero.png)` was accepted as a draft;
- `campaigns update --markdown` and `campaigns variants set --markdown` with the local image were refused the same way, and a variant with the https image was accepted.

The landing gate ran all seven live groups green (43 tests) on its own stage, which it destroyed.

## Settled findings

- Codex review of e53f5c9 (medium): the single tag regex ignored quoted attribute boundaries, so `<img alt="Revenue > costs" src="hero.png">` passed and `src=hero.png` inside an `alt` was refused. Fixed by reading the tag, then its attributes, as HTML tokenizes them; both cases are unit tests. A parser dependency stays out (ADR-0044, alternative 5).
