# Helm Chart

Install the AI Assistant when Argo CD is deployed with the [community Helm chart](https://github.com/argoproj/argo-helm) (`argo/argo-cd`).

## Recommended: the built-in `server.extensions` block

The chart's `server.extensions` block creates the installer initContainer **and** mounts the shared `/tmp/extensions` volume into both the initContainer and the `argocd-server` container for you - so there is no volume wiring to get wrong:

```yaml
configs:
  cm:
    extension.config.assistant: |
      connectionTimeout: 2s
      keepAlive: 360s
      idleConnectionTimeout: 360s
      maxIdleConnections: 30
      services:
      - url: http://local.local.svc.cluster.local:11434
  params:
    server.enable.proxy.extension: "true"
  rbac:
    policy.default: role:readonly
    policy.csv: |
      p, role:readonly, extensions, invoke, assistant, allow

server:
  extensions:
    enabled: true
    extensionList:
      - name: argocd-ai-assistant
        env:
          - name: EXTENSION_URL
            value: "https://github.com/saidsef/argocd-ai-assistant/releases/download/v2.10.0/extension-argocd-ai-assistant-v2.10.0.tar"
```

Replace `v2.10.0` with the [latest release tag](../deployment.md#build-and-package) and the `services[].url` with your backend (see [Proxy & Backend Configuration](proxy.md)).

For an external provider that requires an API key, store it in a labeled Secret (`argocd-ai-assistant-secret`, populated by a secret manager) and reference it from the proxy header - the token is never passed to the chart. See [Injecting the API token](proxy.md#injecting-the-api-token).

> A complete, tested values file (proxy config, RBAC and settings mount included) is at
> [`examples/kind/helm/values.yaml`](https://github.com/saidsef/argocd-ai-assistant/blob/main/examples/kind/helm/values.yaml).

## Alternative: managing the initContainer yourself

If you prefer to define the initContainer directly instead of using the `extensions` block, you **must** also mount the `extensions` volume into the `argocd-server` container (`server.volumeMounts`) - the built-in block above does this for you:

```yaml
server:
  extraArgs:
    - --enable-proxy-extension
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
  volumeMounts:
    - name: extensions
      mountPath: /tmp/extensions/
  volumes:
    - name: extensions
      emptyDir: {}
```

## Add the settings extension

The Assistant reads its model/endpoint from a second "settings" extension. With Helm, mount the settings ConfigMap through `server.volumes` / `server.volumeMounts`:

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

See [Settings Extension](settings.md) for the ConfigMap contents and the available options.

## Next steps

- [Proxy & Backend Configuration](proxy.md) - choose your LLM backend and enable the proxy
- [Local Testing with kind](local-testing.md) - try it on a throwaway cluster (`./examples/kind/setup.sh helm`)
- [Verification & Troubleshooting](verification.md)
