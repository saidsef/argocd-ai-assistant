# Install with the Argo CD Operator

Use this page when Argo CD is managed by the `ArgoCD` custom resource, from argocd-operator or OpenShift GitOps. Each step is a block of that resource, and [the whole resource](#the-whole-resource) puts them together. It needs argocd-operator v0.18.0 or later, because earlier releases ignore `spec.server.volumeMounts`.

In the snippets, replace `<version>` with a [release](../deployment.md#release-artefacts) and the service URL with your backend.

## 1. Proxy extension

```yaml
spec:
  server:
    extraCommandArgs:
      - "--enable-proxy-extension"
```

## 2. Proxy target

```yaml
spec:
  extraConfig:
    extension.config.assistant: |
      services:
      - url: http://ollama.ollama.svc.cluster.local:11434
```

The key must be `extension.config.assistant`, as [Extension name](proxy.md#extension-name) explains. A provider that needs an API key takes a header from a Secret, as described in [API token injection](proxy.md#api-token-injection).

## 3. RBAC

```yaml
spec:
  rbac:
    defaultPolicy: role:readonly
    policy: |
      p, role:readonly, extensions, invoke, assistant, allow
```

Add the `p` line to your existing policy rather than replacing it. `defaultPolicy` gives every user `role:readonly`. Leave it out if you assign roles yourself, as long as each user of the Assistant can invoke the extension and read the Application. [RBAC](proxy.md#rbac) has the details.

## 4. Extension installer

```yaml
spec:
  server:
    initContainers:
      - name: extension-argocd-ai-assistant
        image: quay.io/argoprojlabs/argocd-extension-installer:v1.0.0
        securityContext:
          allowPrivilegeEscalation: false
        env:
          - name: EXTENSION_URL
            value: "https://github.com/saidsef/argocd-ai-assistant/releases/download/v<version>/extension-argocd-ai-assistant.tar"
        volumeMounts:
          - name: extensions
            mountPath: /tmp/extensions/
    volumeMounts:
      - name: extensions
        mountPath: /tmp/extensions/
    volumes:
      - name: extensions
        emptyDir: {}
```

The second `volumeMounts` list belongs to the `argocd-server` container. Without it, the extension is extracted but never served.

## 5. Settings extension

This step is optional. Add it to name a model, replace the prompt or add MCP servers. [Settings extension](settings.md) has the ConfigMap, and this mounts it:

```yaml
spec:
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

## The whole resource

```yaml
apiVersion: argoproj.io/v1beta1
kind: ArgoCD
metadata:
  name: argocd
  namespace: argocd
spec:
  server:
    extraCommandArgs:
      - "--enable-proxy-extension"
    initContainers:
      - name: extension-argocd-ai-assistant
        image: quay.io/argoprojlabs/argocd-extension-installer:v1.0.0
        securityContext:
          allowPrivilegeEscalation: false
        env:
          - name: EXTENSION_URL
            value: "https://github.com/saidsef/argocd-ai-assistant/releases/download/v<version>/extension-argocd-ai-assistant.tar"
        volumeMounts:
          - name: extensions
            mountPath: /tmp/extensions/
    volumeMounts:
      - name: extensions
        mountPath: /tmp/extensions/
      - name: ai-assistant-settings
        mountPath: /tmp/extensions/resources/argocd-ai-assistant-settings
        readOnly: true
    volumes:
      - name: extensions
        emptyDir: {}
      - name: ai-assistant-settings
        configMap:
          name: argocd-ai-assistant-settings
  extraConfig:
    extension.config.assistant: |
      services:
      - url: http://ollama.ollama.svc.cluster.local:11434
  rbac:
    defaultPolicy: role:readonly
    policy: |
      p, role:readonly, extensions, invoke, assistant, allow
```

Apply the settings ConfigMap first, or remove the `ai-assistant-settings` volume and mount. [`examples/kind/operator-cr.yaml`](https://github.com/saidsef/argocd-ai-assistant/blob/main/examples/kind/operator-cr.yaml) is a tested version of this resource that points at a mock LLM and injects the API key from a Secret.
