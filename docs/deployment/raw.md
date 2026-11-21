# Install with raw manifests

Use this page when you apply Argo CD's own `install.yaml`. Steps 1 to 3 change Argo CD's ConfigMaps, and steps 4 and 5 patch the `argocd-server` Deployment. [Applying the changes](#applying-the-changes) gives the commands.

In the snippets, replace `<version>` with a [release](../deployment.md#release-artefacts) and the service URL with your backend.

## 1. Proxy extension

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cmd-params-cm
  namespace: argocd
data:
  server.enable.proxy.extension: "true"
```

## 2. Proxy target

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

The key must be `extension.config.assistant`, as [Extension name](proxy.md#extension-name) explains. A provider that needs an API key takes a header from a Secret, as described in [API token injection](proxy.md#api-token-injection).

## 3. RBAC

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

Add the `p` line to your existing policy rather than replacing it. `policy.default` gives every user `role:readonly`. Leave it out if you assign roles yourself, as long as each user of the Assistant can invoke the extension and read the Application. [RBAC](proxy.md#rbac) has the details.

## 4. Extension installer

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
          volumeMounts:
            - name: extensions
              mountPath: /tmp/extensions/
      volumes:
        - name: extensions
          emptyDir: {}
```

The `argocd-server` container's mount is required. Without it, the extension is extracted but never served.

## 5. Settings extension

This step is optional. Add it to name a model, replace the prompt or add MCP servers. [Settings extension](settings.md) has the ConfigMap, and this adds its volume and mount to the same Deployment:

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

A strategic merge patch merges these lists with those from step 4. Steps 4 and 5 can share one patch file.

## Applying the changes

Save step 2's `data` as `argocd-cm-patch.yaml`, steps 4 and 5 as `argocd-server-patch.yaml`, and the settings ConfigMap as `argocd-ai-assistant-settings.yaml`. Then run:

```shell
kubectl -n argocd apply --server-side --force-conflicts \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

kubectl -n argocd apply -f argocd-ai-assistant-settings.yaml
kubectl -n argocd patch cm argocd-cm            --type merge     --patch-file argocd-cm-patch.yaml
kubectl -n argocd patch cm argocd-cmd-params-cm --type merge -p '{"data":{"server.enable.proxy.extension":"true"}}'
kubectl -n argocd patch cm argocd-rbac-cm       --type merge -p '{"data":{"policy.default":"role:readonly","policy.csv":"p, role:readonly, extensions, invoke, assistant, allow"}}'
kubectl -n argocd patch deploy argocd-server    --type strategic --patch-file argocd-server-patch.yaml
kubectl -n argocd rollout restart deploy argocd-server
```

If the proxy injects an API key, create its Secret before the restart.

The [kind harness](local-testing.md) runs the same commands with these tested files, which point at a mock LLM:

| File | Patches |
|---|---|
| [`examples/kind/raw-cm-patch.yaml`](https://github.com/saidsef/argocd-ai-assistant/blob/main/examples/kind/raw-cm-patch.yaml) | `argocd-cm`, with the proxy target and API key header |
| [`examples/kind/raw-server-patch.yaml`](https://github.com/saidsef/argocd-ai-assistant/blob/main/examples/kind/raw-server-patch.yaml) | `argocd-server`, with the initContainer and both volumes and mounts |
