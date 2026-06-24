# Argo CD Operator

Install the AI Assistant when Argo CD is managed by the [Argo CD Operator](https://argocd-operator.readthedocs.io/) (OpenShift / Kubernetes) by extending your `ArgoCD` custom resource.

This single resource enables the proxy extension, points it at your LLM backend, grants RBAC, and runs the installer initContainer.

!!! warning "The `argocd-server` container must mount the `extensions` volume"
    The initContainer extracts the bundle into an `emptyDir`, but `argocd-server` can only serve it if the **same volume is mounted into the server container too** (`spec.server.volumeMounts` below), not just the initContainer. argocd-operator >= v0.18.0 honours `spec.server.volumeMounts`.

```yaml
apiVersion: argoproj.io/v1beta1
kind: ArgoCD
metadata:
  name: argocd
  namespace: argocd
spec:
  rbac:
    policy: |
      g, system:cluster-admins, role:admin
      p, role:readonly, extensions, invoke, assistant, allow
  extraConfig:
    extension.config.assistant: |
      connectionTimeout: 2s
      keepAlive: 360s
      idleConnectionTimeout: 360s
      maxIdleConnections: 30
      services:
      - url: http://local.local.svc.cluster.local:11434
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
            value: "https://github.com/saidsef/argocd-ai-assistant/releases/download/v2.10.0/extension-argocd-ai-assistant-v2.10.0.tar"
        volumeMounts:
          - name: extensions
            mountPath: /tmp/extensions/
    # The argocd-server container must ALSO mount the extensions volume.
    volumeMounts:
      - name: extensions
        mountPath: /tmp/extensions/
    volumes:
      - name: extensions
        emptyDir: {}
```

Replace `v2.10.0` with the [latest release tag](../deployment.md#build-and-package) and the `services[].url` with your backend (see [Proxy & Backend Configuration](proxy.md)).

For an external provider that requires an API key, store it in a labeled Secret (`argocd-ai-assistant-secret`, populated by a secret manager) and reference it from the proxy header - see [Injecting the API token](proxy.md#injecting-the-api-token).

> A complete, tested CR (with the settings extension wired in) lives at
> [`examples/kind/operator-cr.yaml`](https://github.com/saidsef/argocd-ai-assistant/blob/main/examples/kind/operator-cr.yaml).

## Add the settings extension

The Assistant reads its model/endpoint from a second "settings" extension. With the Operator, mount the settings ConfigMap through `spec.server`:

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

See [Settings Extension](settings.md) for the ConfigMap contents and the available options.

## Next steps

- [Proxy & Backend Configuration](proxy.md) - choose your LLM backend and enable the proxy
- [Local Testing with kind](local-testing.md) - try it on a throwaway cluster (`./examples/kind/setup.sh operator`)
- [Verification & Troubleshooting](verification.md)
