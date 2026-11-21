# Install with the Helm chart

Use this page when Argo CD comes from the community [`argo/argo-cd`](https://github.com/argoproj/argo-helm/tree/main/charts/argo-cd) chart. Each step is a fragment of one values file.

[`examples/argo-cd-values.yaml`](https://github.com/saidsef/argocd-ai-assistant/blob/main/examples/argo-cd-values.yaml) contains all five steps. Edit its backend URL, and pin a version in place of its `latest` download URL, before you install it:

```shell
helm upgrade --install argocd argo/argo-cd \
  --namespace argocd --create-namespace \
  -f examples/argo-cd-values.yaml
```

In the snippets, replace `<version>` with a [release](../deployment.md#release-artefacts) and the service URL with your backend.

## 1. Proxy extension

```yaml
configs:
  params:
    server.enable.proxy.extension: "true"
```

## 2. Proxy target

```yaml
configs:
  cm:
    extension.config.assistant: |
      services:
      - url: http://ollama.ollama.svc.cluster.local:11434
```

The key must be `extension.config.assistant`, as [Extension name](proxy.md#extension-name) explains. A provider that needs an API key takes a header from a Secret, as described in [API token injection](proxy.md#api-token-injection). The chart does not need the key itself.

## 3. RBAC

```yaml
configs:
  rbac:
    policy.default: role:readonly
    policy.csv: |
      p, role:readonly, extensions, invoke, assistant, allow
```

Add the `p` line to your existing policy rather than replacing it. `policy.default` gives every user `role:readonly`. Leave it out if you assign roles yourself, as long as each user of the Assistant can invoke the extension and read the Application. [RBAC](proxy.md#rbac) has the details.

## 4. Extension installer

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

The chart creates the installer initContainer and mounts its volume into both that container and `argocd-server`. If you define the initContainer yourself under `server.initContainers`, add the server-side `server.volumeMounts` entry too.

## 5. Settings extension

This step is optional. Add it to name a model, replace the prompt or add MCP servers. [Settings extension](settings.md) describes the file, and this mounts it from a ConfigMap that the chart creates:

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

extraObjects:
  - apiVersion: v1
    kind: ConfigMap
    metadata:
      name: argocd-ai-assistant-settings
    data:
      extension-settings.js: |
        globalThis.argocdAssistantSettings = {
            model: "<model-name>"
        };
```

## Example values files

| File | Contents |
|---|---|
| [`examples/argo-cd-values.yaml`](https://github.com/saidsef/argocd-ai-assistant/blob/main/examples/argo-cd-values.yaml) | All five steps, ready for `helm -f` |
| [`examples/kind/helm-values.yaml`](https://github.com/saidsef/argocd-ai-assistant/blob/main/examples/kind/helm-values.yaml) | The same steps pointed at a mock LLM, with an API key header and longer timeouts, used by the [kind harness](local-testing.md) |
