# Route 53, ACM and custom HTTPS domains

Verified against AWS documentation on **2026-09-11**.

Related: [CloudFront](cloudfront.md), [sender authentication](deliverability.md), [Alchemy domain resources](../alchemy/aws-domains-and-http.md).

DNS selects an endpoint; a certificate authenticates a hostname; the receiving service must also recognize that hostname. These are three separate configurations. A CNAME to a Lambda Function URL does not give Lambda native support for a custom domain or provision its certificate. CloudFront can terminate the custom hostname and forward to the Function URL. [Function URL fundamentals](https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html)

## Registration, zones and delegation

A registrar controls the domain registration and its parent delegation. A public Route 53 hosted zone contains DNS records served by assigned authoritative name servers. Creating a zone does not move an existing domain to those servers. Update registrar delegation for an apex domain, or publish NS delegation in the parent zone for a separately managed subdomain. [Making Route 53 authoritative](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/migrate-dns-domain-in-use.html)

Multiple hosted zones can have the same name. Inspect the public delegation to identify which one receives queries before editing records or selecting a zone through infrastructure automation. A correct validation record in an undelegated duplicate zone cannot prove domain ownership to ACM.

| Record | Typical purpose | Common mistake |
| --- | --- | --- |
| NS | Delegate a zone to authoritative servers | Creating a child zone without parent delegation |
| A/AAAA alias | Route a name, including the apex, to a supported AWS target | Confusing the record-owning zone ID with the alias target's zone ID |
| CNAME | Map a subdomain to another DNS name; also ACM validation | Creating one at the apex, or appending the zone suffix twice |
| TXT | Publish SPF, DMARC and other metadata | Replacing existing sender configuration without inventory |
| MX | Route incoming mail, including SES custom MAIL FROM feedback | Pointing it at the website endpoint |

## CloudFront aliases

Add the custom hostname to the distribution's alternate domain names and attach a certificate that covers it. Then create a Route 53 alias targeting the distribution. An alias supports the zone apex, where a CNAME does not. Create A and, when IPv6 is enabled, AAAA aliases. CloudFront alias targets use `EvaluateTargetHealth: false`. The registrar need not be Route 53. [Route 53 to CloudFront](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-to-cloudfront-distribution.html)

DNS alone cannot authorize an alternate hostname on a distribution. When moving a hostname between distributions, follow CloudFront's alias-transfer procedure and account for old DNS caches before dismantling the previous endpoint. [Moving alternate domain names](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/alternate-domain-names-move.html)

## Certificate region and coverage

CloudFront's viewer certificate must be requested or imported into ACM in **`us-east-1`**, regardless of the origin Region. A regional consumer such as an Application Load Balancer requires a certificate in its own Region. Viewer TLS and origin TLS are separate connections with separate validation requirements. [CloudFront certificate requirements](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html), [ACM regional usage FAQ](https://aws.amazon.com/certificate-manager/faqs/)

Include every hostname in the certificate's subject alternative names. A wildcard such as `*.example.com` covers `api.example.com`, but not `example.com` or `deep.api.example.com`. Request apex coverage separately where needed. A certificate that is valid but attached to the wrong distribution still produces a broken custom-domain configuration.

## DNS validation and renewal

Publish ACM's exact CNAME names and values in publicly resolvable DNS. Keep the validation records after issuance: ACM uses them for managed renewal while the certificate remains eligible. A private hosted-zone record cannot validate a public certificate. DNS interfaces differ in whether they automatically append the zone name; inspect the final DNS answer. [ACM DNS validation](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html)

For certificates spanning several zones, publish each validation record in its authoritative zone. If issuance remains pending, check delegation first, then record spelling, public resolution and restrictive CAA records. Certificate creation, DNS change acceptance and certificate issuance are distinct states. [DNS validation troubleshooting](https://docs.aws.amazon.com/acm/latest/userguide/troubleshooting-DNS-validation.html)

## Diagnose by layer

1. Query authoritative NS records and the relevant A/AAAA/CNAME answer.
2. Confirm ACM status, Region and hostname coverage.
3. Inspect the certificate actually served with TLS SNI for the custom hostname.
4. Verify the distribution recognizes the alias and has finished deploying.
5. Test origin reachability, Host forwarding, application authentication and cache behavior.

Route 53 `INSYNC` means its authoritative servers received the change; recursive resolver and client caches can still retain older answers until their TTLs expire. Lowering TTL immediately before a migration does not shorten answers already cached with the previous TTL. [Route 53 change status](https://docs.aws.amazon.com/Route53/latest/APIReference/API_GetChange.html)
