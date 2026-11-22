# Settings extension

The Assistant reads its settings from `globalThis.argocdAssistantSettings`, which a second extension file sets. Every setting has a default. A backend that serves one model works without a settings extension, because the Assistant reads the model name from its `/v1/models`.

## Settings file

```javascript
globalThis.argocdAssistantSettings = {
    model: "<model-name>",
    data: {
        mcpServers: ["https://mcp.example.com/mcp"]
    }
};
```

| Setting | Default | Description |
|---|---|---|
| `model` | read from `/v1/models` | The model to use. Without it, the Assistant uses the backend's only model, or lists the models and asks for one when there are several. |
| `data.baseURL` | the Argo CD proxy at `/extensions/assistant` | An OpenAI-compatible base URL, with or without `/v1`. When set, the browser calls it directly. It must then be reachable from the browser and accept requests from the Argo CD origin. |
| `data.apiKey` | none | Sent from the browser as `Authorization: Bearer <key>`, where every user can read it. Use [API token injection](proxy.md#api-token-injection) instead. |
| `data.mcpServers` | none | MCP servers to offer tools from, described in [MCP servers](#mcp-servers). |
| `data.toolCalling` | `auto` | How built-in and MCP tools reach the model. `auto` sends them as `tools` and switches to text for a backend that rejects them, `native` never switches, and `text` always describes them in the system message. Any other value counts as `auto`. |
| `maximumLogLines` | 250 | The most log lines a user can attach, up to 5000. A value that is not a positive whole number falls back to the default. |
| `systemPrompt` | the built-in prompt | Replaces the built-in prompt. A blank value keeps the default. |
| `provider` | ignored | Accepted for compatibility with older ConfigMaps. |

## System prompt override

`systemPrompt` replaces the whole built-in prompt, including its accuracy rules and the shape it sets for replies. [System prompt](../architecture.md#system-prompt) describes both. Carry equivalent rules into your own prompt. The Assistant still adds the attachments, a rule that attached text is data, and any MCP server list to whichever prompt is in force.

## Deploying the settings

The file must be at `/tmp/extensions/resources/argocd-ai-assistant-settings/extension-settings.js` in `argocd-server`. Put it in a ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-ai-assistant-settings
  namespace: argocd
data:
  extension-settings.js: |
    globalThis.argocdAssistantSettings = {
        model: "<model-name>"
    };
```

Step 5 of each install page mounts it: [Operator](operator.md#5-settings-extension), [Helm](helm.md#5-settings-extension), [raw manifests](raw.md#5-settings-extension).

Argo CD serves the file to every browser. It must never hold a secret.

## MCP servers

`data.mcpServers` is a list. Each entry is a URL, or an object with `url`, an optional `name` and an optional `token`:

```javascript
mcpServers: [
    "https://mcp.example.com/mcp",
    { url: "https://wiki.example.com/mcp", name: "wiki" },
    { url: "https://argocd-mcp.example.com/mcp", name: "argocd", token: true }
]
```

- `name` sets the short name users type to use the server's tools. Without it, the Assistant derives one, as [Short names](../architecture.md#short-names) describes.
- `token: true` sends the user's Argo CD token, from the `token` command, to that server as `Authorization: Bearer`. Set it only for a server that acts on Argo CD for the user, because the token carries all of the user's permissions. Only the literal `true` counts.
- An entry without a `url` is skipped, and the other entries still load.

Setting `data.mcpServers` also adds the system-level `/assistant` page and the `token` command.

The browser calls MCP servers directly, not through the proxy. Each server must answer cross-origin requests from the Argo CD origin with these headers:

| Response header | Must include |
|---|---|
| `Access-Control-Allow-Origin` | your Argo CD origin |
| `Access-Control-Allow-Methods` | `POST, OPTIONS` |
| `Access-Control-Allow-Headers` | `content-type, accept, authorization, mcp-session-id` |
| `Access-Control-Expose-Headers` | `mcp-session-id` |

Without `Access-Control-Expose-Headers`, the browser hides the `Mcp-Session-Id` response header from the extension. The handshake appears to work, and every later call fails on a server that requires a session.
