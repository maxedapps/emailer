# Bearer-token authentication for Lambda HTTP endpoints

Verified against AWS and HTTP documentation on **2026-09-11**. The implementation guidance below is a reusable pattern for APIs with a small, explicitly trusted caller set.

Related: [Lambda entry points](lambda-and-api.md), [IAM and secrets](iam-and-secrets.md), [CloudFront](cloudfront.md), [MCP authentication](../mcp/authentication.md).

## Platform authorization and application authorization

Lambda Function URLs support `AWS_IAM` and `NONE`; they have no built-in API-key validator. `AWS_IAM` validates SigV4. With `NONE`, application code must reject unauthorized calls, and those calls can invoke the function and consume compute. Current Function URL permissions involve both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`; scope any public invoke permission to the Function URL path using the documented condition keys. [Function URL authorization](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html)

Choosing application tokens for HTTP callers does not eliminate IAM execution roles, deployment credentials or service-to-service resource policies. A token authorizes the caller to the application; the execution role authorizes that application to AWS.

## Define a narrow credential contract

Use HTTPS and one credential location:

```http
Authorization: Bearer <opaque-random-token>
```

The Bearer scheme can carry tokens from sources other than OAuth. Possession grants access, so never put the credential in URLs, diagnostic output or example configuration checked into source control. Return a generic 401 and a Bearer challenge for missing/invalid credentials; reserve 403 for an authenticated caller lacking permission. The header does not itself provide expiry, refresh, identity or scopes. [RFC 6750](https://www.rfc-editor.org/rfc/rfc6750.html)

Generate a high-entropy secret with a cryptographically secure random generator; 32 random bytes encoded as base64url is a practical choice. Define that format explicitly rather than treating a memorable password or predictable identifier as an API token. Keep token material outside source code and build artifacts. [Node.js cryptographic random generation](https://nodejs.org/api/crypto.html#cryptorandombytessize-callback)

## Validate before performing work

At the HTTP boundary, require exactly one well-formed credential. HTTP field names and the authentication scheme are case-insensitive; the token value is case-sensitive. Reject ambiguous duplicate or comma-joined Authorization values rather than choosing one. Function URL payloads use API Gateway payload format 2.0, including lowercase header keys and combined duplicate values; validate the actual event shape. [Function URL payloads](https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html), [HTTP authentication framework](https://www.rfc-editor.org/rfc/rfc9110.html#section-11)

Fail closed when configuration is missing or malformed. Perform authentication before JSON decoding, database calls, queue publication or tool dispatch where possible. Cap accepted header/body sizes. Separate public routes by explicit method and path; a missing token must never accidentally select a public fallback handler.

Use a constant-time comparison primitive for equal-length byte sequences. Node's `timingSafeEqual` throws for unequal byte lengths and does not make surrounding parsing or branching timing-safe. Enforcing a fixed random-token format simplifies this boundary; do not use substring, prefix or case-insensitive matching. [Node.js comparison contract](https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b)

## Storage and rotation are part of authentication

| Method | Operational consequence |
| --- | --- |
| Lambda environment configuration | Simple local comparison; updates and published versions determine when a new value is used |
| Secrets Manager with runtime retrieval | Central secret lifecycle; cached values delay rotation until refreshed |
| Per-client token records | Independent revocation and attribution; adds lookup/cache and record lifecycle |

Lambda encrypts environment variables at rest, but authorized configuration readers and the function can access plaintext. Secrets Manager is useful when centralized retrieval or rotation is required; it is not needed merely to compare two strings. Neither mechanism prevents a handler from logging a secret. [Lambda environment variables](https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html), [Secrets Manager retrieval and caching](https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets.html)

A rotation procedure can briefly accept current and previous tokens, update callers, then remove the previous token. Bound that overlap, verify every deployed version and account for warm caches. One shared token means shared authority and shared revocation; per-client tokens become useful when those properties are no longer acceptable.

## Boundary checks

Verify missing, wrong, malformed and retired credentials; valid requests; absent server configuration; and each public route. Inspect logs for accidental disclosure. Through CloudFront, test both the distribution and direct Function URL, since edge rules do not automatically protect the origin. CORS is a browser access policy and does not authenticate CLI or MCP callers.
