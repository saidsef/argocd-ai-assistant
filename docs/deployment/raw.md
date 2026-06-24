# Raw Kubernetes Manifests

Install the AI Assistant when you manage Argo CD with raw manifests, by patching three ConfigMaps and the `argocd-server` Deployment.

!!! warning "The `argocd-server` container must mount the `extensions` volume"
    The initContainer extracts the bundle into an `emptyDir`, but `argocd-server` can only serve it if the **same volume is mounted into the server container too** (see the Deployment patch below), not just the initContainer.

## 1. Point the proxy at your backend (`argocd-cm`)

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  extension.config.assistant: |
    connectionTimeout: 2s
    keepAlive: 360s
    idleConnectionTimeout: 360s
    maxIdleConnections: 30
    services:
    - url: http://local.local.svc.cluster.local:11434
```

See [Proxy & Backend Configuration](proxy.md) for other backends (vLLM, OpenAI/DeepSeek, TLS). For an external provider that requires an API key, store it in a labeled Secret (`argocd-ai-assistant-secret`, populated by a secret manager) and reference it from the proxy header - see [Injecting the API token](proxy.md#injecting-the-api-token).

## 2. Enable the proxy extension (`argocd-cmd-params-cm`)

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cmd-params-cm
  namespace: argocd
data:
  server.enable.proxy.extension: "true"
```

## 3. Grant RBAC (`argocd-rbac-cm`)

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

## 4. Install the extension (`argocd-server` Deployment)

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
              value: "https://github.com/saidsef/argocd-ai-assistant/releases/download/v2.10.0/extension-argocd-ai-assistant-v2.10.0.tar"
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

Replace `v2.10.0` with the [latest release tag](../deployment.md#build-and-package).

> Ready-to-apply examples are in [`examples/kind/`](https://github.com/saidsef/argocd-ai-assistant/tree/main/examples/kind)
> (`raw-cm-patch.yaml`, `raw-server-patch.yaml`, applied via `kubectl patch`; see `setup.sh`).

## 5. Add the settings extension

The Assistant reads its model/endpoint from a second "settings" extension. The simplest delivery is a ConfigMap mounted into `argocd-server`:

```yaml
# add to the argocd-server Deployment patch above
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

See [Settings Extension](settings.md) for the ConfigMap contents and the available options.

## Next steps

- [Proxy & Backend Configuration](proxy.md) - choose your LLM backend and enable the proxy
- [Local Testing with kind](local-testing.md) - try it on a throwaway cluster (`./examples/kind/setup.sh raw`)
- [Verification & Troubleshooting](verification.md)
