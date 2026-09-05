# Install with the Helm chart

Use this page when Argo CD comes from the community [`argo/argo-cd`](https://github.com/argoproj/argo-helm/tree/main/charts/argo-cd) chart. Every step below is a fragment of one values file.

Installing another way? [Argo CD Operator](operator.md) · [Raw manifests](raw.md)

!!! tip "One file rather than five blocks"
    The fragments on this page are already assembled at [`examples/argo-cd-values.yaml`](https://github.com/saidsef/argocd-ai-assistant/blob/main/examples/argo-cd-values.yaml). That file tracks the newest release, so only the backend URL needs editing before you pass it:

    ```shell
    helm upgrade --install argocd argo/argo-cd \
      --namespace argocd --create-namespace \
      -f examples/argo-cd-values.yaml
    ```

Replace `<version>` with the [latest release tag](../deployment.md#build-and-package) and `services[].url` with your own backend. [Proxy & Backend Configuration](proxy.md) covers the other backend shapes, API token injection, and the timeouts you can set.

## 1. Enable the proxy extension

```yaml
configs:
  params:
    server.enable.proxy.extension: "true"
```

## 2. Point the proxy at your backend

```yaml
configs:
  cm:
    extension.config.assistant: |
      services:
      - url: http://ollama.ollama.svc.cluster.local:11434
```

The key has to be `extension.config.assistant`. The browser asks for `/extensions/assistant` and that path is compiled into the extension, so a proxy registered under any other name returns 404 on the first question.

For an external provider that needs an API key, keep the key out of `values.yaml` and out of the browser: put it in a labelled Secret and have the proxy inject the header - see [Injecting the API token](proxy.md#injecting-the-api-token). With that approach the chart never sees the token, so you do not set `configs.secret.extra` at all.

## 3. Grant RBAC

Users need `invoke` on the `assistant` extension, and read access to the Application they are asking about. `role:readonly` covers the second part.

```yaml
configs:
  rbac:
    policy.default: role:readonly
    policy.csv: |
      p, role:readonly, extensions, invoke, assistant, allow
```

## 4. Install the extension

The chart's `server.extensions` block creates the installer initContainer and mounts the shared volume into both it and the `argocd-server` container, so there is no volume wiring to get wrong:

```yaml
server:
  extensions:
    enabled: true
    extensionList:
      - name: argocd-ai-assistant
        env:
          - name: EXTENSION_URL
            value: "https://github.com/saidsef/argocd-ai-assistant/releases/download/v<version>/extension-argocd-ai-assistant.tar"
```

Defining the initContainer yourself under `server.initContainers` works too, but then the server-side `server.volumeMounts` entry is yours to add - the block above is doing it for you, and a missing server-side mount is the most common reason the tab never appears.

## 5. Add the settings extension

Optional. Every setting has a default, and a backend serving a single model is fully configured by steps 1 to 4 - the Assistant reads the model name off `/v1/models`. Add this when you want to pin a model, override the system prompt, or configure MCP servers.

The settings arrive as a second extension: a ConfigMap mounted into `argocd-server`. [Settings Extension](settings.md) has the ConfigMap and every field it accepts, this is where you mount it.

```yaml
server:
  volumes:
    - name: ai-assistant-settings
      configMap:
        name: argocd-ai-assistant-settings
  volumeMounts:
    - name: ai-assistant-settings
      mountPath: /tmp/extensions/resources/argocd-ai-assistant-settings
      readOnly: true
```

The chart can carry the ConfigMap itself, so the settings are part of the release rather than a separate `kubectl apply`:

```yaml
extraObjects:
  - apiVersion: v1
    kind: ConfigMap
    metadata:
      name: argocd-ai-assistant-settings
    data:
      extension-settings.js: |
        globalThis.argocdAssistantSettings = {
            model: "your-model"
        };
        (() => { console.log("Argo CD AI Assistant settings loaded"); })();
```

## Worked values files

| File | What it is |
|------|------------|
| [`examples/argo-cd-values.yaml`](https://github.com/saidsef/argocd-ai-assistant/blob/main/examples/argo-cd-values.yaml) | the five blocks assembled, ready for `helm -f` |
| [`examples/kind/helm-values.yaml`](https://github.com/saidsef/argocd-ai-assistant/blob/main/examples/kind/helm-values.yaml) | the same, pointed at a mock LLM, applied by the [kind harness](local-testing.md) on every run |

## Next steps

- [Settings Extension](settings.md) - pin a model, change the prompt, add MCP servers
- [Proxy & Backend Configuration](proxy.md) - other backends, API token injection, TLS
- [Verification & Troubleshooting](verification.md) - confirm it loaded and answers
