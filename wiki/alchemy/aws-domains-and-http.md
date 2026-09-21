# AWS domains, HTTP origins and tracking resources in Alchemy

[Alchemy](alchemy.md)

Reference baseline: **Alchemy `2.0.0-beta.77` / Effect `4.0.0-rc.112`**, inspected on **2026-09-11**. Provider-source findings below are not claims about every Alchemy release.

Related: [CloudFront behavior](../aws/cloudfront.md), [DNS and certificates](../aws/route53-and-acm.md), [runtime bindings](runtime-and-bindings.md), [configuration and secrets](environments-and-state.md).

## Compose distinct resource responsibilities

| Resource | Responsibility | Does not establish |
| --- | --- | --- |
| `AWS.Lambda.Function` | Runtime and optional Function URL | Application token validation |
| `AWS.CloudFront.Distribution` | Origins, path behaviors, viewer TLS and cache policies | Every origin's resource policy |
| `AWS.CloudFront.OriginAccessControl` | Origin signing configuration | Viewer authentication |
| `AWS.ACM.Certificate` | Certificate request and supported DNS validation | Registrar delegation |
| `AWS.Route53.HostedZone` / `Record` | DNS zone and record ownership | Ownership of another account's DNS |
| `AWS.SES.ConfigurationSet` | Sending and tracking settings | Tracking DNS or event destinations |

Use returned attributes and Outputs to express dependencies. A domain becoming known during planning does not mean its DNS is delegated, certificate issued or distribution deployed. [Outputs and references](outputs-and-references.md)

## Function URLs and authentication

In beta.77, `functionUrl: true` selects `authType: "NONE"` and `invokeMode: "BUFFERED"`. The object form exposes `authType`, `cors` and `invokeMode`; `false` disables the URL. The default also enables a URL, so set this property explicitly for non-HTTP functions. [Published Function provider](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/Lambda/Function.ts)

These settings configure AWS, not an application authentication middleware. Resolve credentials in the appropriate constructor phase and enforce authorization in the handler. Changing the URL's invocation mode does not prove that the generated runtime adapter streams bodies: check the adapter's response path and exercise an incremental response. See [token authentication](../aws/http-token-authentication.md) and [Lambda response streaming](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html).

## DNS validation: guide versus provider

The [custom-domains guide](https://alchemy.run/aws/networking/custom-domains/) describes `us-east-1` as fixed for `AWS.ACM.Certificate`. The published beta.77 provider actually exposes `region?: string`, defaults it to `us-east-1`, and uses it for certificate requests. Changing it replaces the certificate. This permits regional consumers to request certificates in their Region; CloudFront viewer certificates still require `us-east-1`.

For DNS validation, `hostedZoneId` is optional. Without it, the provider searches for the most specific matching public hosted zone for `domainName`. With a matching zone, it upserts validation records and waits for issuance. With no matching zone, it can return a pending certificate for externally managed validation. A yielded resource therefore does not universally guarantee `ISSUED`. [Versioned certificate implementation](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/ACM/Certificate.ts)

The automatic validation path uses one selected zone. Inspect SANs that cross zone boundaries rather than assuming it routes each validation record to a different zone. Check public delegation before applying: selecting an undelegated duplicate zone can leave issuance waiting indefinitely from the operator's perspective.

## Record ownership and duration units

`AWS.Route53.Record` accepts `name`, `type`, and either `records` with a TTL or an `aliasTarget`. Top-level `hostedZoneId` identifies the zone being edited; `aliasTarget.hostedZoneId` identifies the AWS target's canonical zone. For a CloudFront alias, use the distribution's returned `domainName` and `hostedZoneId` attributes.

Record create/update uses UPSERT and waits for Route 53 `INSYNC`. This can replace an existing record set at the same identity; inspect ownership before adoption. `read` never returns `Unowned`, so an existing record is treated as owned and adoption is silent. TTL accepts `Duration.Input`: a bare number means milliseconds, while AWS receives seconds. Prefer an explicit value such as `"60 seconds"`. DNS caches remain independent of the provider's completion. [Record provider](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/Route53/Record.ts)

Creating `HostedZone` supplies name servers but does not update an external registrar. Keep shared DNS resources under one owner; avoid independent stages reconciling the same record. [Domain automation guide](https://alchemy.run/aws/networking/custom-domains/)

## CloudFront primitives and policy selection

`Distribution` exposes `origins`, a default behavior and additional path behaviors. Origins distinguish S3 settings from custom HTTP settings and can reference an `originAccessControlId`. Behaviors select target origins, allowed methods, cache policies and origin request policies. Configure resource permissions in addition to attaching OAC. [Distribution source](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/CloudFront/Distribution.ts)

The package exports `MANAGED_CACHING_DISABLED_POLICY_ID`, `MANAGED_CACHING_OPTIMIZED_POLICY_ID`, and `MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID`. The last is appropriate for Lambda URL Host handling; it is unsuitable for an SES tracking origin, which requires the viewer Host. Policy constants are conveniences, not universally safe defaults. [Managed-policy exports](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/CloudFront/ManagedPolicies.ts)

Higher-level Website resources can combine certificates, aliases and distributions. Consult their exact `domain`, `cert` and `dns` contracts before dropping to primitives. Bring-your-own certificates or externally managed DNS require a complete external setup; a disabled DNS option cannot make missing validation or delegation disappear.

## SES tracking properties are separate from events

Beta.77 uses the Alchemy property `tracking`, not the AWS API's `TrackingOptions` spelling:

```json
{
  "tracking": {
    "customRedirectDomain": "links.example.com",
    "httpsPolicy": "REQUIRE"
  }
}
```

This is a `ConfigurationSet` props fragment. The provider maps it to the SES API. Omitting `tracking` preserves existing tracking settings; removing the prop is not a reset operation. Likewise, an omitted `httpsPolicy` does not request an explicit replacement value. Inspect drift and intended reset behavior before relying on omission. [ConfigurationSet source](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/SES/ConfigurationSet.ts)

Create an enabled `ConfigurationSetEventDestination` with `matchingEventTypes` containing `OPEN` and/or `CLICK`, along with the required destination and permissions. Bind that configuration set through `SES.SendEmail(identity, configurationSet)` for bound sends. Neither the tracking prop nor the event resource provisions the branded tracking domain. [Event destination source](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/SES/ConfigurationSetEventDestination.ts), [SendEmail binding](https://unpkg.com/alchemy@2.0.0-beta.77/src/AWS/SES/SendEmail.ts)

## Verification boundaries

Typecheck the exact pinned package set, then inspect the plan for DNS ownership, certificate Region, replacements, policies and public Function URLs. For cloud validation, check public DNS, ACM issuance, distribution readiness, direct-origin access and a real delivered email. A compiling declaration verifies none of those remote outcomes by itself.
