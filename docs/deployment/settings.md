# Settings Extension

The Assistant needs to know which LLM backend to use. Since Argo CD extensions have no native configuration mechanism, settings are deployed as a **second extension** that sets `globalThis.argocdAssistantSettings`.

## Create the settings file

Create a JavaScript file named `extension-settings.js`:

```javascript
globalThis.argocdAssistantSettings = {
    model: "gpt-4",
    data: {
        baseURL: "http://local.local.svc.cluster.local:11434/v1"
    }
};

(() => {
    console.log("Initializing Argo CD AI Assistant Settings");
})();
```

| Setting | Required | Description |
|---------|----------|-------------|
| `provider` | No | Ignored. Accepted for backwards compatibility with existing ConfigMaps; a single generic OpenAI-compatible provider is always used. |
| `model` | Recommended | Model name (e.g., `gpt-4`). If omitted, queries fail with `LLM model is not configured`. |
| `data.baseURL` | No | OpenAI-compatible API base URL, with or without a trailing `/v1` (both forms resolve to the same `/v1/chat/completions` endpoint). Defaults to the Argo CD proxy path if omitted. |
| `data.apiKey` | No | API key sent **from the browser** as `Authorization: Bearer …`. It is readable in the browser - **not recommended**, prefer server-side injection via the proxy ([Injecting the API token](proxy.md#injecting-the-api-token)). |
| `data.mcpServers` | No | MCP servers, each CORS-enabled for the Argo CD origin. An entry is either a URL string or `{url, name}`, where `name` overrides the short handle the assistant would otherwise derive (e.g. `["https://mcp.example.com", {url: "https://cf.example.com/mcp", name: "wiki"}]`). The assistant always knows which servers are configured, but only offers a server's tools when the user names it in their message or the one before it. See [MCP Tool Integration](../architecture.md#mcp-tool-integration). |
| `maximumLogLines` | No | Max log lines attachable (default: 250, hard ceiling 5000). A value that is not a positive whole number falls back to the default. |
| `systemPrompt` | No | Overrides the built-in assistant persona/instructions. The default is an Argo CD / Kubernetes expert prompt that grounds answers in the attached manifest, events, and logs, and carries the accuracy rules below. Setting this **replaces** those rules - it does not add to them. The attached context and the MCP server list are appended either way. |

!!! warning "An override replaces the accuracy rules"
    The default prompt forbids four failure modes by name - guessing, assuming, lying and waffling - and states each as a checkable rule rather than an adjective: an absent field is unknown rather than default, a `[truncated: …]` marker means the model is reading a fragment, an inference must be labelled as one, and "the context does not show this" is an acceptable answer. A custom `systemPrompt` discards all of it, so carry the equivalent wording across if you set one. The attachments and the MCP server list (with its own tool-calling instructions) are appended to whichever prompt is in force.

!!! note "Leave `baseURL` unset to route through the proxy"
    If `data.baseURL` is omitted the Assistant calls the Argo CD proxy path (`/extensions/assistant`), which forwards to the backend you configure in [Proxy & Backend Configuration](proxy.md). This is the recommended setup - it keeps API keys out of the browser.

## Deploy the settings extension

`extension-settings.js` has to land in `/tmp/extensions/resources/argocd-ai-assistant-settings/`. Put it in a ConfigMap and mount that into the `argocd-server` pod - nothing to host, and it version-controls like the rest of your manifests.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-ai-assistant-settings
  namespace: argocd
data:
  extension-settings.js: |
    globalThis.argocdAssistantSettings = {
        model: "deepseek-chat",
        data: {
            baseURL: "https://api.deepseek.com/v1"
        }
    };
    (() => { console.log("Argo CD AI Assistant Settings loaded"); })();
```

Mount it at `/tmp/extensions/resources/argocd-ai-assistant-settings` using the `server.volumes` / `server.volumeMounts` (or CR / Deployment) snippet on your deployment method page: [Operator](operator.md#add-the-settings-extension), [Helm](helm.md#add-the-settings-extension), or [Raw manifests](raw.md#5-add-the-settings-extension).

## Keep API keys out of the browser

The settings JS file is served to the browser, so anything in it - including `data.apiKey` - is readable by any user. Never put a real API key there. Instead, route requests through the [Argo CD Proxy Extension](proxy.md) and inject the `Authorization` header server-side from a Secret - see [Injecting the API token](proxy.md#injecting-the-api-token).
