# ADR-0041: Personalized templates, opt-outs across lists, and safe test sends

- Status: Proposed
- Date: 2026-11-18
- Authority: The operator decided on 2026-11-18 (task 4068) that every copy is a template rendered per recipient (Liquid, rendered in the send path before the recipient claim, HTML escaped only in the HTML part, validated on save with line and column, a language per copy for dates); that templates must carry the unsubscribe link and the postal address, with no fallback footer; that an opt-out from any list keeps every campaign away; that several campaigns to one person are fine; that re-importing must not drop a contact's name and attributes; that preview and test send render as a chosen contact and test sends must not mail list members; and that `campaigns check` renders every recipient without sending.
- Amends:
  - [ADR-0004](0004-sender-owned-one-click-unsubscribe.md): no footer is appended; each template places the link and the address itself.
  - [ADR-0019](0019-markdown-campaign-bodies.md): the backend footer block is gone; Markdown authors write the two tags.
  - [ADR-0020](0020-drafts-previews-and-test-sends.md): test sends go only to named addresses; preview and test render as a contact.
  - [ADR-0027](0027-signup-api-scoped-keys-and-double-opt-in.md) and [ADR-0037](0037-single-opt-in-keys-and-integration-opt-out.md): an opt-out is recorded per list but keeps the address from every list until a confirmed sign-up brings it back to that list.
  - [ADR-0028](0028-campaign-variants-and-attribute-merge.md): import merges name and attributes into an existing contact.
- Plan: [0041-personalized-templates.plan.md](0041-personalized-templates.plan.md)

## Context

- A cohort mail needs per-person greetings and dates, each with a fallback for a missing value and for a whole sentence. The README promised "no merge fields": every recipient got a copy as written, plus an appended footer.
- Opt-outs were per list (ADR-0027). Someone who left one list still got campaigns sent to another.
- `lists import` kept an existing contact's name and attributes untouched, so a re-import with new data silently dropped it.
- `campaigns test --list` mailed every member of a list.

## Decision

1. **Every copy is a LiquidJS template.** Subject, text and HTML are templates, rendered per recipient with `contact.email`, `contact.name`, `contact.<attribute>` (`contact["member since"]` for keys with spaces; the two fields win over a same-named attribute), `unsubscribe_url` and `postal_address`.
   - Only the HTML part escapes output. Filters are strict, `include`/`render`/`layout` are refused, and `date` refuses a value it cannot read instead of printing it unchanged.
   - A copy has an optional language (BCP 47, English when absent), which names months and days in `date` and is the `lang` of the HTML document the CLI renders from Markdown.
2. **Validated on save.** Create, update and set-variant parse each given part before any write and answer `422 InvalidTemplate` with the part, line and column for a syntax error, an unknown filter or tag, a variable outside the five above, or a body part without `{{ unsubscribe_url }}` and `{{ postal_address }}`. No footer is appended any more.
3. **Rendered in the send path.** The dispatcher compiles each copy once per slice and renders a member after their status read, before the pacing slot and the claim. A render that fails, or whose output lacks the link or the address or has a subject that is no longer one line within the limit, records the member as skipped with reason `unrenderable` and logs the campaign, copy and error, never the address. `compose` only adds the unsubscribe headers.
4. **An opt-out keeps the address off every list.** The address item keeps `optOuts`, the lists left, as evidence, and gains `rejoined`, the lists confirmed by double opt-in since the latest opt-out. An address is unsubscribed for list L while `optOuts` is non-empty and L is not in `rejoined`. An opt-out adds its list and clears `rejoined`; a confirmed sign-up adds its list to `rejoined`. One function decides this for sends, test sends and sign-ups.
5. **Import keeps contact data.** Joining an existing contact sets the name given and merges the attributes given, under the contact's revision; `contacts set-attributes` and its CSV accept `name`.
6. **Preview and test as a contact; tests only to named addresses.** `POST /campaigns/:id/render { as, variant? }` answers the copy a contact gets; `campaigns preview --as` prints it. Test sends take `{ to, variant?, as? }`; the list form is gone. Without `as`, preview and test render with no contact, so every fallback shows. A test's unsubscribe link is minted for the test address, never for the `as` contact.
7. **Links stay the same for everyone.** Clicks are tracked per campaign only, through UTM tags written into a template's links (`utm_source=emailer`, `utm_medium=email`, `utm_campaign=<campaign slug>`, `utm_content=<copy or link>`), as ADR-0028 has it; the operator confirmed on 2026-11-18 (task 4073) that no link carries an email, contact ID or other per-person code. Templates could put a contact value into a link, but the README's template rules forbid it.
8. **`campaigns check`** pages the campaign's list through `POST /campaigns/:id/check`, applies filter and standing, chooses each recipient's copy and renders it without sending. It reports counts and, per recipient, failures, fallbacks (a `contact.*` value the copy uses is missing or blank) and odd values (surrounding whitespace, line breaks).

## Alternatives

- **Keep copies as written and append the footer** (the simplest): it cannot greet anyone by name, which is the goal.
- **Render in `compose`, after the claim**: a render failure would leave a claimed row with no submission. Rendering before the claim makes it an ordinary skip.
- **A fallback footer when the tags are missing**: rejected by the operator; a template states where the link and the address go.
- **Bare variables (`{{ first_name }}`)**: an attribute named like `unsubscribe_url` would shadow it, and a typo is indistinguishable from an attribute. `contact.` keeps the namespaces apart and lets save refuse unknown names.
- **Opt-out as one address-wide flag**: a confirmed sign-up to one list would have to clear it and revive every list the person left. `rejoined` lifts it for the confirmed list only.
- **Opt-outs on the contact**: the address item is what the send path already reads and what survives a deleted contact (ADR-0006); a contact flag would need a second read or a copy kept in step.
- **A test list capped at 20 members**: still mails real people whenever the list is a real one.

## Consequences

- Authors write the unsubscribe link and the postal address into every template; the CLI's Markdown layout no longer adds them.
- Steady-state cost: none added.
  - Send path: rendering is CPU inside the existing invocation, a copy compiled once per slice; no read or write added; an `unrenderable` skip row replaces the send row it stands for. The `liquidjs` bundle adds well under 1 MB to the API and dispatcher code.
  - Opt-out: the same single read per recipient and the same single update per opt-out; the address item gains a few bytes.
  - Import merge: an extra strongly consistent read per existing contact imported with a name or attributes, and a Put in place of a condition check (same write units under 1 KiB); the index is keys-only, so no index write. Admin path only.
  - Render, check: on demand only. A check reads the list once (one page read plus one batched contact read per 100 members) and one address item per member.
- An address that ever opted out can never be moved onto by a contact's address change (ADR-0006's check), because `optOuts` is kept.

## Verification

- `pnpm check`: 1009 unit tests, among them the template engine (fallbacks, escaping, strict `date`, refused tags and variables with line and column), the send path's `unrenderable` skip, `campaigns check`, the opt-out model and the import merge.
- Live suite: the cross-list opt-out, the double opt-in rejoin, test sends only to named simulator addresses, preview and test as a contact, `campaigns check` and every send with template bodies. LIVE_RESULT
- Hand check on a test stage, simulator addresses only: a save with an unknown filter refused with part, line and column; a German variant rendered "März 2024" with `lang="de-DE"`; fallbacks for a contact without values; `campaigns check` named an unreadable date and the fallbacks; an opt-out from another list skipped the member; a re-import kept the name and attributes; the send accepted 3 and skipped 2.
