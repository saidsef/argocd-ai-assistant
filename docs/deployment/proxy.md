# Proxy and backend

The browser sends every LLM request to `/extensions/assistant` on the Argo CD server, and Argo CD's [proxy extension](https://argo-cd.readthedocs.io/en/stable/developer-guide/extensions/proxy-extensions/) forwards it to the backend configured here. The API key stays in a Secret on the server. This applies while `data.baseURL` is unset in the [settings](settings.md). With it set, the browser calls that URL directly.

## Extension name

The path `/extensions/assistant` is compiled into the extension. Three places must use the name `assistant`:

- the config key `extension.config.assistant`
- the resource in the RBAC line `p, role:readonly, extensions, invoke, assistant, allow`
- the path the browser requests, `/extensions/assistant`

A proxy registered under any other name answers every question with a 404.

## Backends

Only `services[].url` is required. The extension appends `/v1/chat/completions` and `/v1/models` to it.

```yaml
extension.config.assistant: |
  services:
  - url: http://vllm.vllm.svc.cluster.local:8000
```

An in-cluster Ollama is `http://ollama.ollama.svc.cluster.local:11434`.

An external provider needs an `Authorization` header, which the proxy adds from a Secret:

```yaml
extension.config.assistant: |
  services:
  - url: https://api.deepseek.com
    headers:
    - name: Authorization
      value: '$argocd-ai-assistant-secret:openai-api-key'
```

| Provider | `services[].url` |
|---|---|
| OpenAI | `https://api.openai.com` |
| Anthropic | `https://api.anthropic.com` |
| DeepSeek | `https://api.deepseek.com` |

These providers serve several models. Name one in the `model` [setting](settings.md).

## API token injection

Argo CD replaces a `$`-prefixed config value with a value from a Secret:

| Reference | Resolves from |
|---|---|
| `$key` | the `argocd-secret` Secret |
| `$secret-name:key` | the Secret `secret-name`, which must carry the label `app.kubernetes.io/part-of: argocd` |

Argo CD substitutes the value as it stands, and the Secret must hold the whole header value, `Bearer <your-api-token>`. A bare token is forwarded as `Authorization: <your-api-token>`, which providers reject.

A dedicated Secret keeps the key out of `argocd-secret`, which the Helm chart and the Operator manage. Create it from a secret manager rather than from a literal in Git. With the [External Secrets Operator](https://external-secrets.io/):

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: argocd-ai-assistant-secret
  namespace: argocd
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: my-secret-store
    kind: ClusterSecretStore
  target:
    name: argocd-ai-assistant-secret
    creationPolicy: Owner
    template:
      metadata:
        labels:
          app.kubernetes.io/part-of: argocd
      data:
        openai-api-key: "Bearer {{ .token }}"
  data:
    - secretKey: token
      remoteRef:
        key: secret/argocd/assistant
        property: api-token
```

Sealed Secrets and SOPS work as well, provided the result is a Secret named `argocd-ai-assistant-secret` with the `app.kubernetes.io/part-of: argocd` label and an `openai-api-key` key.

## Connection timeouts

Argo CD's proxy has four connection settings, each with a default:

| Key | Default | Meaning |
|---|---|---|
| `connectionTimeout` | 2s | longest wait to open a connection to the backend |
| `keepAlive` | 15s | interval between keep-alive probes on an open connection |
| `idleConnectionTimeout` | 60s | how long an idle connection stays open |
| `maxIdleConnections` | 30 | most idle connections kept open |

They go at the top of the block:

```yaml
extension.config.assistant: |
  connectionTimeout: 5s
  services:
  - url: http://vllm.vllm.svc.cluster.local:8000
```

The extension also stops a reply that stays silent for longer than its own fixed limit, and shows "The assistant stopped responding". A proxy setting cannot change that limit.

## RBAC

A user of the Assistant needs two permissions:

- `invoke` on the `assistant` extension, from `p, role:readonly, extensions, invoke, assistant, allow`
- read access to the Application they ask about, because the proxy checks each request against an Application

The extension names the Application in the `Argocd-Application-Name` and `Argocd-Project-Name` headers. The system-level `/assistant` page exists only when `data.mcpServers` is set. It does not have an Application of its own, and uses the first one the user can read. A user who cannot read any Application can use the resource tab but not that page.

The policy line grants `invoke` to `role:readonly` and every role above it. Name a narrower role to limit who can spend the API key.

## TLS to the backend

For a backend whose certificate comes from a private CA, mount the CA certificate into `argocd-server`. In Helm values:

```yaml
server:
  volumeMounts:
    - mountPath: /etc/pki/tls/certs/custom-ca.crt
      name: custom-ca
      subPath: ca.crt
  volumes:
    - name: custom-ca
      configMap:
        name: custom-ca-bundle
```

The same volume and mount go under `spec.server` in the Operator's resource, and into the `argocd-server` Deployment for raw manifests.

## Security considerations

| Risk | Effect | Mitigation |
|---|---|---|
| API key in a Secret | Secrets are base64-encoded, not encrypted, and readable by anyone allowed to get them | Encrypt etcd at rest and restrict Secret RBAC |
| API key in `values.yaml` or a `kubectl patch` | The key ends up in Git history, shell history or CI logs | Create the Secret from a secret manager |
| `data.apiKey` in the settings | Every user can read the key in the browser | Inject the key through the proxy instead |
| Write access to `argocd-cm` | `services[].url` can be pointed elsewhere, sending the key and user data with it | Restrict who can change Argo CD's config |
| `invoke` granted to `role:readonly` | Every user can spend the key and send data to the provider | Grant `invoke` to specific roles |
| Unpinned `EXTENSION_URL` | A changed or tampered tar runs JavaScript in every user's Argo CD session | Pin a version, serve it over HTTPS, and verify it with `EXTENSION_CHECKSUM_URL` |
| External provider | Cluster data leaves the network, and a leaked key can run up cost | Scope, rotate and cap the key, or use an in-cluster model |
| Plain HTTP to the backend | The key crosses the network unencrypted | Use HTTPS, with a private CA if needed |
