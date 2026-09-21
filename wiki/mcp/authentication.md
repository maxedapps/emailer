# MCP authentication and OAuth interoperability

Normative reference: **MCP `2026-07-28`**, checked **2026-09-11**. This article distinguishes local credentials, explicitly configured HTTP tokens and the standardized OAuth discovery flow.

Related: [transports and compatibility](transports-and-compatibility.md), [Lambda bearer authentication](../aws/http-token-authentication.md), [secret lifecycle](../aws/iam-and-secrets.md).

## Choose the credential interaction deliberately

| Interaction | Credential path | Compatibility boundary |
| --- | --- | --- |
| Local stdio wrapper | Environment or a protected local credential store | Does not run MCP HTTP OAuth on its stdio channel |
| HTTP with a preconfigured token | Client supplies an Authorization header on every request | Client must support that configuration; no automatic login/discovery is implied |
| MCP HTTP OAuth | Client discovers the resource and authorization server, obtains an access token | Requires the MCP authorization profile across all participants |

Authorization is optional in MCP; implementations that support HTTP authorization SHOULD follow its profile. Stdio implementations SHOULD retrieve credentials from the environment instead. A static token can protect a private HTTP server, but describe it as custom configured authentication rather than a complete MCP OAuth implementation. [Authorization scope](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

Never expose a privileged API token as a tool parameter, prompt, resource or model-visible configuration value. A wrapper can attach it internally to API requests. This is an implementation pattern for credential isolation, not a new protocol grant.

## Resource and authorization servers have different jobs

The MCP server validates access tokens and authorizes operations. The authorization server authenticates the user/client and issues tokens. They can be separate services. A valid token must be intended for this resource; an ID token or a token for a downstream API is not a substitute.

For standard discovery, publish Protected Resource Metadata with `authorization_servers`. A 401 challenge can point to that document with `resource_metadata`. Clients also support well-known discovery, including the path-specific protected-resource location for nested MCP endpoints. They then discover the selected authorization server through OAuth metadata or OpenID Connect discovery. Credentials and registration state belong to that issuer, not to a global client-ID namespace. [Discovery requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery)

Metadata documents must be reachable before obtaining the protected API token. Do not place them behind the same authentication challenge that depends on discovering them. Validate metadata and constrain outbound discovery fetches; caller-supplied URLs introduce SSRF exposure. [Authorization security](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)

## Client registration is not user authentication

The July revision recommends Client ID Metadata Documents (CIMD) and retains Dynamic Client Registration (DCR) as an optional deprecated compatibility mechanism. A client supporting all mechanisms prefers configured pre-registration, then advertised CIMD, then advertised DCR, then manual client information.

CIMD uses an HTTPS URL with a path as the client ID. Its JSON document identifies the same URL exactly and declares client metadata, including redirect URIs. The authorization server validates both the document and redirect URI membership. Fetching a document is not proof that a user granted permission. The revision references **CIMD draft-00**; do not silently substitute a later draft's contract. [Client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)

An OAuth client secret embedded in a distributed CLI is not confidential. Native applications generally use a public client with authorization code plus PKCE and a supported redirect mechanism. A device authorization grant is a separate authorization-server capability, not something guaranteed by MCP support. [OAuth for native applications](https://www.rfc-editor.org/rfc/rfc8252.html), [Device authorization grant](https://www.rfc-editor.org/rfc/rfc8628.html)

## Validate issuer, audience and scopes independently

The client sends `resource` in both authorization and token requests, including when the authorization server does not advertise support. The MCP server validates token audience, validity and operation permissions. Invalid tokens receive 401; insufficient permission receives 403. [MCP token requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

Before redirecting, record the issuer from validated server metadata alongside the authorization attempt. Before redeeming the code, compare a returned `iss` exactly with that recorded issuer. If the server advertised `authorization_response_iss_parameter_supported: true`, a missing `iss` must fail. If support was not advertised, a present `iss` still must match; an absent one can proceed. [Issuer validation rules](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

Use PKCE and bind the callback to the initiating attempt. Keep credentials isolated by issuer and resource. Bound scope-upgrade retries; repeated 403 responses must not create an endless login loop. Do not forward an inbound MCP token to another service as that service's credential. [Token and redirect protections](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)

## SDK integration still leaves responsibilities with the host

The official TypeScript SDK v2 migration guidance requires the host to pass callback `iss` information to `finishAuth`, retain the issuer stamp when persisting credentials, and implement durable discovery-state storage. Its callback helper does not validate application `state`; validate that correlation before invoking the helper. Choose the documented insufficient-scope behavior and maintain retry limits across requests.

These requirements are not automatically enabled merely because a transport speaks the modern protocol. Persist discovery context as durably as the PKCE verifier so a process restart cannot disconnect the callback from its original authorization server. Keep refresh tokens confidential and account for server-specific issuance behavior. [Official SDK auth migration guidance](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)

## Compatibility and verification

Assess compatibility across transport revision, registration method, callback support and token validation separately. A dual-era server can preserve the same authentication boundary on both protocol paths. A client supporting older initialization may still support modern OAuth discovery; the inverse is also possible.

For a configured-token integration, test that the real client sends the header on discovery and tool requests. For OAuth, test new authorization, callback rejection, refresh, wrong issuer/audience, scope step-up, revoked credentials and restart during login. Include the actual target client: accepting a token in an isolated HTTP test does not prove a client can acquire or configure it.
