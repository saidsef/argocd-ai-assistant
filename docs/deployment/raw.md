# Install with raw manifests

Use this page when you apply Argo CD's own `install.yaml` and patch it. Three ConfigMaps and one Deployment patch.

Installing another way? [Argo CD Operator](operator.md) · [Helm chart](helm.md)

Replace `<version>` with the [latest release tag](../deployment.md#build-and-package) and `services[].url` with your own backend. [Proxy & Backend Configuration](proxy.md) covers the other backend shapes, API token injection, and the timeouts you can set.

## 1. Enable the proxy extension

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cmd-params-cm
  namespace: argocd
data:
  server.enable.proxy.extension: "true"
```

## 2. Point the proxy at your backend

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  extension.config.assistant: |
    services:
    - url: http://ollama.ollama.svc.cluster.local:11434
```

The key has to be `extension.config.assistant`. The browser asks for `/extensions/assistant` and that path is compiled into the extension, so a proxy registered under any other name returns 404 on the first question.

For an external provider that needs an API key, keep the key out of Git and out of the browser: put it in a labelled Secret and have the proxy inject the header - see [Injecting the API token](proxy.md#injecting-the-api-token).

## 3. Grant RBAC

Users need `invoke` on the `assistant` extension, and read access to the Application they are asking about. `role:readonly` covers the second part.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.default: role:readonly
  policy.csv: |
    p, role:readonly, extensions, invoke, assistant, allow
```

## 4. Install the extension

The installer initContainer downloads the tar and extracts it into an `emptyDir`. `argocd-server` can only serve what it extracted if the **same volume is mounted into the server container too**, which is the one step people miss.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: argocd-server
  namespace: argocd
spec:
  template:
    spec:
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
      containers:
        - name: argocd-server
          # The server container must mount the SAME volume to serve the files
          # the initContainer extracted - without this the extension never loads.
          volumeMounts:
            - name: extensions
              mountPath: /tmp/extensions/
      volumes:
        - name: extensions
          emptyDir: {}
```

## 5. Add the settings extension

Optional. Every setting has a default, and a backend serving a single model is fully configured by steps 1 to 4 - the Assistant reads the model name off `/v1/models`. Add this when you want to pin a model, override the system prompt, or configure MCP servers.

The settings arrive as a second extension: a ConfigMap mounted into `argocd-server`. [Settings Extension](settings.md) has the ConfigMap and every field it accepts, this is where you mount it - the same `argocd-server` patch as step 4, with a second volume and mount:

```yaml
spec:
  template:
    spec:
      containers:
        - name: argocd-server
          volumeMounts:
            - name: ai-assistant-settings
              mountPath: /tmp/extensions/resources/argocd-ai-assistant-settings
              readOnly: true
      volumes:
        - name: ai-assistant-settings
          configMap:
            name: argocd-ai-assistant-settings
```

A strategic merge patch merges those lists with the ones from step 4, so both volumes and both mounts survive. Apply them as one patch to save a rollout.

## Applying it

Install Argo CD, then patch the three ConfigMaps and the Deployment:

```shell
kubectl -n argocd apply --server-side --force-conflicts \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

kubectl -n argocd apply -f settings-configmap.yaml
kubectl -n argocd patch cm argocd-cm            --type merge     --patch-file cm-patch.yaml
kubectl -n argocd patch cm argocd-cmd-params-cm --type merge -p '{"data":{"server.enable.proxy.extension":"true"}}'
kubectl -n argocd patch cm argocd-rbac-cm       --type merge -p '{"data":{"policy.default":"role:readonly","policy.csv":"p, role:readonly, extensions, invoke, assistant, allow"}}'
kubectl -n argocd patch deploy argocd-server    --type strategic --patch-file server-patch.yaml
kubectl -n argocd rollout restart deploy argocd-server
```

Tested patch files for the last two, pointed at a mock LLM and with the API token injected from a labelled Secret:

| File | Patches |
|------|---------|
| [`examples/kind/raw-cm-patch.yaml`](https://github.com/saidsef/argocd-ai-assistant/blob/main/examples/kind/raw-cm-patch.yaml) | `argocd-cm` - the proxy target |
| [`examples/kind/raw-server-patch.yaml`](https://github.com/saidsef/argocd-ai-assistant/blob/main/examples/kind/raw-server-patch.yaml) | `argocd-server` - initContainer, both volumes, both mounts |

The [kind harness](local-testing.md) applies them exactly like the commands above on every run.

## Next steps

- [Settings Extension](settings.md) - pin a model, change the prompt, add MCP servers
- [Proxy & Backend Configuration](proxy.md) - other backends, API token injection, TLS
- [Verification & Troubleshooting](verification.md) - confirm it loaded and answers
