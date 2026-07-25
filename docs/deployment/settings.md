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
| `data.mcpServers` | No | Array of MCP server HTTP endpoints (e.g. `["https://mcp.example.com"]`), each CORS-enabled for the Argo CD origin. Tools are offered to the model only when the user names the server in the message. See [MCP Tool Integration](../architecture.md#mcp-tool-integration). |
| `maximumLogLines` | No | Max log lines attachable (default: 250, hard ceiling 5000). A value that is not a positive whole number falls back to the default. |
| `systemPrompt` | No | Overrides the built-in assistant persona/instructions. Defaults to an Argo CD / Kubernetes expert prompt that grounds answers in the attached manifest, events, and logs. |

!!! note "Leave `baseURL` unset to route through the proxy"
    If `data.baseURL` is omitted the Assistant calls the Argo CD proxy path (`/extensions/assistant`), which forwards to the backend you configure in [Proxy & Backend Configuration](proxy.md). This is the recommended setup - it keeps API keys out of the browser.

## Deploy the settings extension

There are two ways to deliver `extension-settings.js` into `/tmp/extensions/resources/argocd-ai-assistant-settings/`.

### Option A: ConfigMap volume mount (recommended)

Create a ConfigMap with the settings file, then mount it into the `argocd-server` pod. This avoids hosting a second tar and is simplest to manage with GitOps.

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

### Option B: Second initContainer (tar archive)

Package the settings as their own tar, host it on a reachable URL, and add a second installer initContainer alongside the main one:

```shell
mkdir -p resources/argocd-ai-assistant-settings
cp extension-settings.js resources/argocd-ai-assistant-settings/
tar -cvf argocd-ai-assistant-settings.tar resources
```

```yaml
initContainers:
  - name: extension-argocd-ai-assistant
    image: quay.io/argoprojlabs/argocd-extension-installer:v1.0.0
    securityContext:
      allowPrivilegeEscalation: false
    env:
      - name: EXTENSION_URL
        value: "https://github.com/saidsef/argocd-ai-assistant/releases/download/v2.10.0/extension-argocd-ai-assistant-v2.10.0.tar"
    volumeMounts:
      - name: extensions
        mountPath: /tmp/extensions/
  - name: extension-argocd-ai-assistant-settings
    image: quay.io/argoprojlabs/argocd-extension-installer:v1.0.0
    securityContext:
      allowPrivilegeEscalation: false
    env:
      - name: EXTENSION_URL
        value: "https://your-host/argocd-ai-assistant-settings.tar"
    volumeMounts:
      - name: extensions
        mountPath: /tmp/extensions/
```

## Keep API keys out of the browser

The settings JS file is served to the browser, so anything in it - including `data.apiKey` - is readable by any user. Never put a real API key there. Instead, route requests through the [Argo CD Proxy Extension](proxy.md) and inject the `Authorization` header server-side from a Secret - see [Injecting the API token](proxy.md#injecting-the-api-token).
