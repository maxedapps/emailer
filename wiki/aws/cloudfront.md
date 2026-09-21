# CloudFront origins, caching and HTTP APIs

Verified against AWS documentation on **2026-09-11**.

Related: [Lambda HTTP entry points](lambda-and-api.md), [Route 53 and ACM](route53-and-acm.md), [S3](s3.md), [HTTP token authentication](http-token-authentication.md).

CloudFront provides an HTTPS distribution in front of origins. A distribution can route different paths to different origins, but routing, caching, origin authentication and viewer authentication are separate settings. Establish each explicitly; creating a distribution does not make an underlying public endpoint private.

## Match the policy to the origin

| Origin | Host handling | Access boundary |
| --- | --- | --- |
| Lambda Function URL | Send the Lambda origin hostname; `AllViewerExceptHostHeader` is designed for this use | Public URL plus application authentication, or IAM-authenticated origin access |
| Regular S3 bucket endpoint | Use the bucket origin configuration | OAC and a scoped bucket policy can keep the bucket private |
| SES tracking endpoint | Preserve the viewer's tracking-domain `Host` | Follow SES's custom tracking-domain procedure |

The managed `AllViewerExceptHostHeader` origin request policy forwards viewer headers, cookies and query strings except `Host`, which CloudFront replaces with the origin hostname. The SES tracking origin needs the opposite Host behavior. Reusing a Lambda policy for SES can therefore break redirects. [Managed origin request policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html), [SES tracking domains](ses-engagement-tracking.md#custom-https-tracking-domains)

An origin request policy controls what reaches the origin. A cache policy controls the cache key and lifetimes. Forwarding a header does not necessarily include it in the cache key. This distinction matters whenever a response depends on authorization, a cookie or a query parameter. [Cache and origin request policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/controlling-origin-requests.html)

## Cache static content and dynamic operations separately

Use immutable object names for cacheable assets. For authenticated APIs and event-recording redirects, disabling caching is a conservative starting point: a cached response can skip authorization or event recording entirely. Configure the necessary HTTP methods separately; enabling POST forwarding does not turn an API into cacheable static content.

The managed `CachingDisabled` policy sets minimum, default and maximum TTL to zero. A cache policy with a positive minimum TTL can retain responses even when the origin sends `Cache-Control: no-cache`, `no-store` or `private`. Inspect the effective policy rather than assuming the response header wins. [Managed cache policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html)

Keep API error handling separate from website fallbacks. Replacing every origin error with an HTML page and HTTP 200 conceals authorization failures and breaks protocol clients. For streams, verify actual incremental delivery and intermediary timeouts; an SSE content type alone does not prove the response is streamed.

## Lambda OAC and bearer tokens

CloudFront Origin Access Control for Lambda requires a Function URL with `AWS_IAM`. Grant the CloudFront service principal both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`, constrained to the distribution ARN. With signing behavior `always`, CloudFront replaces the incoming `Authorization` header with its SigV4 signature.

`no-override` is not a bearer-token passthrough solution for an IAM origin: when CloudFront preserves the viewer's Authorization value, that viewer must have supplied valid SigV4 credentials signed for the Lambda origin. AWS also requires a SHA-256 body hash in `x-amz-content-sha256` for PUT/POST to this origin; Lambda does not support an unsigned payload here. [Lambda OAC requirements](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html)

If an application needs bearer authentication behind OAC, design a separate, trusted credential-forwarding channel and reject spoofed copies at the edge. Account for body signing before adopting this combination. Alternatively, a `NONE` URL can validate bearer tokens in the handler, but its direct URL remains reachable. A separate origin-only secret header can distinguish the distribution path if consistently enforced; it is still application validation. These are alternative integration patterns, not equivalent security boundaries.

## S3 OAC protects the origin

Use a regular S3 bucket origin, keep Block Public Access enabled, and grant only the needed object access to CloudFront with a distribution-scoped bucket policy. SSE-KMS objects additionally require appropriate KMS key permissions. OAC does not work with an S3 website endpoint; that endpoint is a custom origin. [S3 OAC](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html)

A private bucket can still serve publicly through its distribution. Viewer restrictions, when needed, require a separate mechanism such as signed URLs/cookies or application authorization.

## Verify the complete request path

Exercise the custom hostname and direct origin independently. Check a valid credential, a missing credential, a POST body, query parameters, and repeated requests from different callers. For tracking, confirm repeated requests still produce origin activity. For static content, confirm intended cache hits. Examine origin logs alongside CloudFront response headers; a successful DNS lookup establishes none of these behaviors.
