# MCP transports and protocol compatibility

Normative reference: **MCP `2026-07-28`**, checked **2026-09-11**. SDK behavior is separately identified below; protocol dates and package major versions are not interchangeable.

Related: [MCP authentication](authentication.md), [Lambda HTTP entry points](../aws/lambda-and-api.md), [Effect HTTP and CLI runtimes](../effect/http-cli-and-runtime.md).

## Local and remote execution

MCP carries JSON-RPC messages with defined methods, capabilities, metadata and error semantics. A REST endpoint with a tool-like name is not automatically an MCP endpoint. A local wrapper can implement MCP and call another API, keeping the API independent of protocol concerns. [Transport model](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)

| Transport | Deployment model | Operational implication |
| --- | --- | --- |
| stdio | Client starts a subprocess | Keep stdout exclusively for protocol messages; send diagnostics to stderr |
| Streamable HTTP | Independently reachable server | Authenticate each request and validate Origin when present |
| Legacy HTTP+SSE | Separate older SSE/message endpoints | Add only when supporting clients that require this deprecated transport |

Stdio uses newline-delimited UTF-8 messages. A Lambda Function URL is an HTTP endpoint, so a local stdio wrapper must bridge to it rather than expose Lambda as a subprocess. [stdio binding](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)

## July 2026 changed the protocol lifecycle

| Concern | 2025-era revisions | `2026-07-28` |
| --- | --- | --- |
| Startup | `initialize`, then initialized notification | Per-request version/capabilities; no initialization handshake |
| Identity context | Established during initialization | Request metadata; never an authentication credential |
| Server discovery | Initialization response | Server implements `server/discover`; client can skip calling it |
| Server requests | Independent requests on the connection | Multi Round-Trip Requests embedded in results |
| HTTP sessions | Optional session ID and standalone GET stream | No protocol sessions, GET stream or resumable event IDs |

The body metadata is authoritative. HTTP mirrors the protocol version, method and applicable name into headers; validate agreement rather than trusting routing headers independently. Request-scoped SSE still exists. Sessionless does not mean streamless, and it does not remove application state or operation idempotency. [Transport overview](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports), [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)

## HTTP request boundary

Use POST to the MCP endpoint. Clients advertise both `application/json` and `text/event-stream`; the server can return either. Preserve `MCP-Protocol-Version`, `Mcp-Method`, applicable `Mcp-Name` and any schema-designated `Mcp-Param-*` headers through proxies. Values needing encoding use the specified Base64 sentinel convention; use an SDK rather than inventing an encoding.

Reject invalid present Origin values with 403. Header/body mismatches use HTTP 400 with `HeaderMismatch` (`-32020`). Missing/invalid authorization is a separate HTTP failure. Disabling caching is a conservative deployment choice for authenticated tool calls. [HTTP binding and validation](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)

## Backward compatibility must be explicit

Supporting both eras means implementing each era's lifecycle. Accepting an older version string while requiring modern headers does not provide compatibility. A dual-era client can probe and fall back to initialization when the response identifies a legacy server. Recognized modern errors, especially `UnsupportedProtocolVersionError` (`-32022`), require correction or selection of a mutually supported version instead.

An old client cannot automatically learn the new lifecycle from a modern-only server. Serve the older behavior when required, or return actionable unsupported-version information. The 2024 HTTP+SSE transport is an additional compatibility concern beyond 2025 Streamable HTTP. [Version negotiation and compatibility matrix](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)

Do not reinterpret failed authentication, a server outage or a proxy HTML error as permission to bypass access controls. Keep protocol negotiation separate from credential negotiation. Preserve authentication on every compatibility path.

## TypeScript SDK v2: entry points matter

The official SDK migration guide inspected on 2026-09-11 documents these behaviors:

- Hand-constructed `Client`, `Server` and `McpServer` retain the legacy lifecycle by default.
- `createMcpHandler(factory)` from `@modelcontextprotocol/server` serves modern HTTP requests and defaults to `legacy: "stateless"` for older requests.
- `legacy: "reject"` selects a modern-only handler. Existing sessionful legacy hosting needs a separate compatible path.
- `serveStdio(factory)` supplies the era-aware stdio entry point.
- Client `versionNegotiation: { mode: "auto" }` opts into modern probing with legacy fallback; a pin requests modern-only operation.

An SDK major upgrade alone therefore does not establish July 2026 support. Pin a release that contains these entry points and verify its migration guide. [Official revision migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)

## Serverless integration and validation

A Web `Request`/`Response` handler fits a small HTTP adapter, but a Lambda Function URL supplies an AWS event envelope. Decode its body/base64 flag and translate status, headers and body correctly. Buffered JSON responses suit finite calls; SSE additionally requires a genuinely streaming runtime adapter and suitable proxy timeouts. [Lambda payload contract](https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html), [Lambda streaming](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html)

Store durable operations outside the MCP connection and use application operation IDs for retry safety. A process-local session map cannot coordinate separate Lambda environments. Long-running jobs can return a durable job identifier through ordinary tools; adopting a Tasks extension requires explicit capability support.

Validate with an independent official client for each supported era: discovery/initialization, tools/list, a tool call, unsupported versions, malformed mirrored headers and authorization failures. Exercise the HTTP adapter, not only in-memory handler calls. The SDK guide notes that linked in-memory transports exercise legacy instances; its fetch-based handler path is appropriate for modern HTTP tests. No interoperability test is implied merely by reading the guide.
