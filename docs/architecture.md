### Introduction

Argo CD enables extending the User Interface (UI) it provides via an
[extension](https://argo-cd.readthedocs.io/en/latest/developer-guide/extensions/ui-extensions/) mechanism.
The Assistant for Argo CD uses the
[Resource Tab Extension](https://argo-cd.readthedocs.io/en/latest/developer-guide/extensions/ui-extensions/#resource-tab-extensions) to provide
an additional tab on the Resource slide-out that appears when a Resource is clicked in the UI.

The Assistant uses a single generic LLM provider that speaks the standard OpenAI-compatible chat completions API, so it works with any compatible backend (a local inference server, vLLM, OpenAI, Azure OpenAI, and so on) rather than being tied to a specific one.

### Architecture

The extension is composed of two main parts: the UI extension bundle (JavaScript/React) loaded by the Argo CD server, and the backend LLM service accessed through the Argo CD Proxy Extension.

![Architecture of the Assistant for Argo CD: the Assistant tab in the user's browser reads manifests, events, pod logs and the Application summary from the Argo CD API on the same origin, sends chat requests to an OpenAI-compatible LLM backend through the proxy extension at /extensions/assistant which authorises each one against an Application, and calls MCP servers directly rather than through the proxy](architecture.svg)

**Communication flow:**

1. The Argo CD server loads the extension JS bundle via an initContainer at startup.
2. When a user opens a resource and clicks the **Assistant** tab, the extension renders a chatbot interface.
3. The extension fetches the resource manifest (provided by Argo CD), events (via Argo CD API), and optionally container logs.
4. User queries + context are sent to the LLM backend through the Argo CD [Proxy Extension](https://argo-cd.readthedocs.io/en/stable/developer-guide/extensions/proxy-extensions/), avoiding CORS issues.
5. The proxy forwards requests to the configured LLM service. Responses stream back via SSE.

CORS would otherwise block the browser from calling the backend directly, so all backend traffic is proxied through the `argocd-server` pod. Streaming responses are handled natively by the proxy - no client-side header workarounds.

### Query Context

Each query is sent to the backend with additional context:

1. **Resource manifest** - the live manifest, provided by Argo CD when the extension is invoked.
2. **Argo CD Application summary** - a distilled `argocd app get` view (source/Helm chart, sync status, health, sync policy, images, and any out-of-sync or degraded resources) fetched from the Argo CD REST API. For an Application resource it replaces the full manifest (a large token saving); for a child resource it is attached alongside, grounding it in the owning Application's GitOps state.
3. **Events** - retrieved automatically and attached. Cached, not continuously updated.
4. **Logs** (optional) - a single container's log, attached via a guided flow. Distilled to a `<timestamp> <line>` block with the pod named once in a header, rather than the raw API envelope (measured ~35-60% fewer tokens). Cached and re-sent on every request, re-run the flow to refresh.

Every context item is bounded twice: by item count (events, resource lists, log lines) and by size in characters. When an item exceeds its ceiling it is truncated with a visible `[truncated: showing N of M characters ...]` marker, so the model knows it is reading a fragment.

!!! note
    Most inference providers cap tokens, so large context items can exhaust the query limit.

### Chatbot Interface

The chat interface is a custom React implementation (`ChatInterface` + the `useChat` hook), with streaming responses and Markdown rendering (`marked` + `dompurify`). The conversation flow:

1. **Start** - an opening message with the resource Kind and Name, plus how to attach logs if the resource supports them.
2. **Loop** - the user enters queries, the node loops after each one. Keywords switch to other flows.
3. **`attach`** - starts the Attach Logs flow: pick a container, then the number of lines (up to the configured limit). The distilled log is attached to every subsequent question in the session until **New chat** detaches it.
4. **`token`** (when `data.mcpServers` is set) - the user supplies an Argo CD API token. It is stored in `sessionStorage` and sent to every configured MCP server as an `Authorization: Bearer` header, so a server such as [mcp-github-pr-issue-analyser](https://github.com/saidsef/mcp-github-pr-issue-analyser) can act on Argo CD on the user's behalf.

### Enabling MCP

MCP is enabled by configuring `data.mcpServers` in the [settings extension](deployment/settings.md) - there is no feature flag. When at least one server is configured, the extension also registers a system-level extension at `/assistant` (in addition to the per-resource tab), where users can manage an Argo CD API token for MCP server access, and the `token` conversation flow becomes available.

The Argo CD Proxy Extension authorises every request against a specific Application, via the `Argocd-Application-Name` and `Argocd-Project-Name` headers. The system-level page has no resource, and therefore no Application of its own, so on load it looks up the first Application the user can read and uses it purely for that authorisation - nothing about it is sent to the model. A user who can read no Applications cannot use the system-level page; the assistant says so rather than surfacing the proxy's raw `400 Invalid headers` response.

### MCP Tool Integration

When `data.mcpServers` is set, the LLM provider connects to each server over an HTTP-streamable JSON-RPC transport as the tab opens, not on the first message. The browser calls servers directly, so each must send CORS headers for the Argo CD origin.

Connecting early is what makes the short name usable: a server's handle comes from the name it reports during the handshake, so waiting until the first message would mean the badge and the welcome message could only offer a URL hostname - and would then disagree with the assistant once it did connect. The warm-up and a first message sent while it is still running share one handshake, so a server is never initialised twice.

Per message the provider:

1. Reuses that connection, or makes it now if the warm-up has not finished or a server needs re-probing.
2. Injects a **server roster** into the system message whenever any server is configured, listing each server's name, hostname, state, and its tool names. This is reference only - nothing in it is callable - and it is what lets the assistant answer "which MCP servers are available?" instead of reporting that it has no information about MCP.
3. Injects an "Available tools" section (descriptions and JSON schemas, grouped by server) **only for the server(s) the user has named** - see [Addressing a server](#addressing-a-server) below. A conversation naming no server gets no tools, so a normal question never triggers a call.
4. Scans the response for a `<tool>` tag (only for advertised tools) and, if found, routes it via `tools/call`, appending the result as a follow-up query. If a tool block is emitted when nothing is callable, the assistant retries once tool-free rather than showing the raw block.

#### Addressing a server

A server is addressed when one of its **handles** appears as a whole word, case-insensitively, in the current message **or the one immediately before it**. The two-turn window is what makes a natural follow-up work:

```text
you:       docs, what does a sync wave do?      <- names "docs", its tools are offered
assistant: ...
you:       and how do hooks interact with them? <- names nothing, but "docs" is still offered
you:       is the pod healthy?                  <- outside the window, no tools offered
```

Only the user's own previous message counts. Assistant replies are never scanned - they routinely name every server now that the roster exists, and matching one would advertise everything on every subsequent turn.

#### The short name

Each server gets one short **handle**. It is what the badge shows, what the welcome message suggests, what the roster lists, and what the assistant asks you to type - one string, decided once, so no surface can advertise a name the matcher does not accept.

It is derived from the first distinctive word of the server-reported name, or failing that of the hostname's first label. Filler words are dropped (`mcp`, `server`, `service`, `svc`, `api`, `tool`, `www`, `local`, `internal`, `cluster`, `default`), as is anything shorter than 4 characters - so a server at `api.example.com` never turns the word "api" into an invocation.

| server | reports | handle |
|---|---|---|
| `mcp.docs.example.com` | `docs-mcp-server` | `docs` |
| `github-mcp.saidsef.co.uk` | `github-mcp-saidsef` | `github` |
| `searxng.internal` | nothing | `searxng` |
| `api.example.com` | nothing | `api.example.com` (nothing distinctive to use) |

Set `name` on the server entry to override it (see [Settings](deployment/settings.md)). If two servers would end up with the same handle, neither keeps it - both fall back to their hostname, then to `host:port` - so you are never asked to type something that addresses two servers at once.

Addressing still accepts the server's reported name, its full hostname, and the hostname's first label, so anything that worked before the handle existed keeps working.

Tool calls chain a bounded few times per query (the final turn forced tool-free) to keep multi-step lookups fast. Servers are unauthenticated by default, the `token` flow adds an `Authorization: Bearer` header. A broken server never breaks the assistant - if it is unreachable, exposes no tools, or a call fails, the provider logs the reason to the console and continues in LLM-only mode.

The conversation state, streaming transport, and LLM-provider calls are all bespoke (`useChat` + `LlmProvider`), because the Assistant needs features beyond an off-the-shelf chatbot, such as attaching context and the bounded MCP tool loop.
