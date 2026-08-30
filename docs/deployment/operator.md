# Install with the Argo CD Operator

Use this page when Argo CD is managed by the `ArgoCD` custom resource - argocd-operator on Kubernetes, or OpenShift GitOps. Every step below is a block of that one CR, apart from the settings ConfigMap in step 5.

Installing another way? [Helm chart](helm.md) · [Raw manifests](raw.md)

!!! note "argocd-operator >= v0.18.0"
    That is the first release to honour `spec.server.volumeMounts`, which is where the server-side mount in [step 4](#4-install-the-extension) goes. On an earlier operator the extension extracts and never loads.

Replace `v15.3.2` with the [latest release tag](../deployment.md#build-and-package) and `services[].url` with your own backend. [Proxy & Backend Configuration](proxy.md) covers the other backend shapes, API token injection, and the timeouts you can set.

## 1. Enable the proxy extension

```yaml
spec:
  server:
    extraCommandArgs:
      - "--enable-proxy-extension"
```

## 2. Point the proxy at your backend

```yaml
spec:
  extraConfig:
    extension.config.assistant: |
      services:
      - url: http://ollama.ollama.svc.cluster.local:11434
```

The key has to be `extension.config.assistant`. The browser asks for `/extensions/assistant` and that path is compiled into the extension, so a proxy registered under any other name returns 404 on the first question.

For an external provider that needs an API key, keep the key out of Git and out of the browser: put it in a labelled Secret and have the proxy inject the header - see [Injecting the API token](proxy.md#injecting-the-api-token).

## 3. Grant RBAC

Users need `invoke` on the `assistant` extension, and read access to the Application they are asking about. `role:readonly` covers the second part.

```yaml
spec:
  rbac:
    policy: |
      g, system:cluster-admins, role:admin
      p, role:readonly, extensions, invoke, assistant, allow
```

## 4. Install the extension

The installer initContainer downloads the tar and extracts it into an `emptyDir`. `argocd-server` can only serve what it extracted if the **same volume is mounted into the server container too**, which is the one step people miss.

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
            value: "https://github.com/saidsef/argocd-ai-assistant/releases/download/v15.3.2/extension-argocd-ai-assistant-v15.3.2.tar"
        volumeMounts:
          - name: extensions
            mountPath: /tmp/extensions/
    # The argocd-server container must mount the same volume.
    volumeMounts:
      - name: extensions
        mountPath: /tmp/extensions/
    volumes:
      - name: extensions
        emptyDir: {}
```

## 5. Add the settings extension

Optional. Every setting has a default, and a backend serving a single model is fully configured by steps 1 to 4 - the Assistant reads the model name off `/v1/models`. Add this when you want to pin a model, override the system prompt, or configure MCP servers.

The settings arrive as a second extension: a ConfigMap mounted into `argocd-server`. [Settings Extension](settings.md) has the ConfigMap and every field it accepts, this is where you mount it.

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

## The whole CR

The five blocks assembled, with the extension volume and the settings volume in the same lists:

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
            value: "https://github.com/saidsef/argocd-ai-assistant/releases/download/v15.3.2/extension-argocd-ai-assistant-v15.3.2.tar"
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
    policy: |
      g, system:cluster-admins, role:admin
      p, role:readonly, extensions, invoke, assistant, allow
```

Apply the settings ConfigMap in the same namespace before the CR, or drop the `ai-assistant-settings` volume and mount if you are not using it.

A tested version of this CR, pointed at a mock LLM and with the API token injected from a labelled Secret, is [`examples/kind/operator-cr.yaml`](https://github.com/saidsef/argocd-ai-assistant/blob/main/examples/kind/operator-cr.yaml). The [kind harness](local-testing.md) applies it on every run.

## Next steps

- [Settings Extension](settings.md) - pin a model, change the prompt, add MCP servers
- [Proxy & Backend Configuration](proxy.md) - other backends, API token injection, TLS
- [Verification & Troubleshooting](verification.md) - confirm it loaded and answers
