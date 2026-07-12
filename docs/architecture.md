### Introduction

Argo CD enables extending the User Interface (UI) it provides via an
[extension](https://argo-cd.readthedocs.io/en/latest/developer-guide/extensions/ui-extensions/) mechanism.
The Assistant for Argo CD uses the
[Resource Tab Extension](https://argo-cd.readthedocs.io/en/latest/developer-guide/extensions/ui-extensions/#resource-tab-extensions) to provide
an additional tab on the Resource slide-out that appears when a Resource is clicked in the UI.

The Assistant uses a single generic LLM provider that speaks the standard OpenAI-compatible chat completions API, so it works with any compatible backend (a local inference server, vLLM, OpenAI, Azure OpenAI, and so on) rather than being tied to a specific one.

### Architecture

The extension is composed of two main parts: the UI extension bundle (JavaScript/React) loaded by the Argo CD server, and the backend LLM service accessed through the Argo CD Proxy Extension.

```
 +-------------------+        +------------------------+        +------------------+
 |   User Browser    |        |   Argo CD Server Pod   |        |   LLM Backend    |
 |                   |        |                        |        |                  |
 |  Argo CD UI  +----------> |  Extension JS Bundle   |        |  (OpenAI-compat) |
 |                   |   |    |  (/tmp/extensions/...) |        |                  |
 |  Assistant Tab    |   |    |                        |        |  Local/Ollama    |
 |  (React Chatbot)  |   |    |  Proxy Extension       +------> |  vLLM            |
 |                   |   |    |  (/extensions/assistant)       |  OpenAI          |
 |  Attach Logs      |   |    |                        |        |  DeepSeek        |
 |  (guided flow)    |   |    |  Settings ConfigMap    |        |  Azure           |
 +-------------------+   |    |  (argocd-ai-assistant-  |        +------------------+
                         |    |   settings)            |
                         |    +------------------------+
                         |
                         +--> Argo CD API (events, logs, manifests)
```

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
2. **Events** - retrieved automatically and attached. Cached, not continuously updated.
3. **Logs** (optional) - a single container's log, attached via a guided flow. Cached and re-sent on every request; re-run the flow to refresh.

!!! note
    Most inference providers cap tokens, so large context items can exhaust the query limit.

### Chatbot Interface

The chat interface uses [React ChatBotify](https://react-chatbotify.com/), which provides streaming, markdown rendering, and more. The conversation flow:

1. **Start** - an opening message with the resource Kind and Name, plus how to attach logs if the resource supports them.
2. **Loop** - the user enters queries; the node loops after each one. Keywords switch to other flows.
3. **`attach`** - starts the Attach Logs flow: pick a container, then the number of lines (up to the configured limit).
4. **`token`** (when `data.mcpServers` is set) - the user supplies an Argo CD API token. It is stored in `sessionStorage` and sent to every configured MCP server as an `Authorization: Bearer` header, so a server such as [mcp-github-pr-issue-analyser](https://github.com/saidsef/mcp-github-pr-issue-analyser) can act on Argo CD on the user's behalf.

### Enabling MCP

MCP is enabled by configuring `data.mcpServers` in the [settings extension](deployment/settings.md) - there is no feature flag. When at least one server is configured, the extension also registers a system-level extension at `/assistant` (in addition to the per-resource tab), where users can manage an Argo CD API token for MCP server access, and the `token` conversation flow becomes available.

### MCP Tool Integration

When `data.mcpServers` is set, the LLM provider lazily connects to each server over an HTTP-streamable JSON-RPC transport. The browser calls servers directly, so each must send CORS headers for the Argo CD origin. Per message the provider:

1. Sends an `initialize` handshake on first use, then lists tools via `tools/list`.
2. Injects an "Available tools" section into the system message **only for the server(s) named in that message** (by reported name or hostname, matched as a whole word, case-insensitive). A message naming no server gets no tools - so a normal question never triggers a call.
3. Scans the response for a `<tool>` tag (only for advertised tools) and, if found, routes it via `tools/call`, appending the result as a follow-up query.

Tool calls chain a bounded few times per query (the final turn forced tool-free) to keep multi-step lookups fast. Servers are unauthenticated by default; the `token` flow adds an `Authorization: Bearer` header. A broken server never breaks the assistant - if it is unreachable, exposes no tools, or a call fails, the provider logs the reason to the console and continues in LLM-only mode.

React ChatBotify's built-in LLM-provider support is not used, because the Assistant needs features beyond it, such as attaching context.
