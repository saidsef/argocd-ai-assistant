# Proxy & Backend Configuration

The Assistant talks to your LLM through the Argo CD **Proxy Extension**, which routes browser traffic through `argocd-server` (avoiding CORS and keeping API keys out of the browser). This page covers where the proxy forwards requests, how to enable it, and the RBAC needed to invoke it.

The `extension.config.assistant` block tells the proxy where to forward requests. Where you put it depends on your install method - see [Operator](operator.md), [Helm](helm.md), or [Raw manifests](raw.md) - but the value is the same.

## Backend examples

### Local inference server (in-cluster)

```yaml
extension.config.assistant: |
  connectionTimeout: 2s
  keepAlive: 360s
  idleConnectionTimeout: 360s
  maxIdleConnections: 30
  services:
  - url: http://local.local.svc.cluster.local:11434
```

### vLLM (in-cluster)

```yaml
extension.config.assistant: |
  connectionTimeout: 2s
  keepAlive: 360s
  idleConnectionTimeout: 360s
  maxIdleConnections: 30
  services:
  - url: http://vllm.vllm.svc.cluster.local:8000
```

### OpenAI / DeepSeek (external) with proxy headers

For an external provider, route through the proxy and inject the `Authorization` header server-side so the API key never reaches the browser:

```yaml
extension.config.assistant: |
  connectionTimeout: 2s
  keepAlive: 15s
  idleConnectionTimeout: 60s
  maxIdleConnections: 30
  services:
  - url: https://api.deepseek.com
    headers:
    - name: Authorization
      value: '$argocd-ai-assistant-secret:openai-api-key'
```

!!! important "Secret value must include the `Bearer` prefix"
    The `$` prefix is required for Argo CD template injection - without it the value is treated as a literal string. `$argocd-ai-assistant-secret:openai-api-key` is resolved from the `openai-api-key` key of a Secret named `argocd-ai-assistant-secret` - see [Injecting the API token](#injecting-the-api-token) below for how to create it.

    **The secret value itself must include the `Bearer ` prefix** (e.g. `Bearer <your-api-token>`). The proxy is a generic reverse proxy: it performs raw string substitution and does not inspect, validate, or transform headers. If the secret contains only the token, the proxy forwards `Authorization: <your-api-token>` verbatim, which the LLM backend rejects as malformed. Store the full header value:

    ```
    Bearer <your-api-token>
    ```

If your provider is CORS-enabled and reachable directly you may not strictly need the proxy, but routing through it (or a backend gateway) is recommended so API keys are never exposed to the browser.

## Injecting the API token

Argo CD substitutes `$`-prefixed config values from Kubernetes Secrets, so the token never lives in the ConfigMap, `values.yaml`, or the browser. Two forms exist:

| Reference | Resolves from |
|-----------|---------------|
| `$key` | the built-in `argocd-secret` |
| `$secret-name:key` | a **separate Secret** named `secret-name` carrying the label `app.kubernetes.io/part-of: argocd` |

**Prefer the dedicated labelled Secret** (`$argocd-ai-assistant-secret:openai-api-key`, as shown above): it keeps the token out of the chart-owned `argocd-secret`, and with the Operator avoids touching an operator-managed Secret.

### Recommended: a managed, labelled Secret

Populate the Secret from a secret manager - never a literal in Git. With the [External Secrets Operator](https://external-secrets.io/):

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: argocd-ai-assistant-secret
  namespace: argocd
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: my-secret-store          # your (Cluster)SecretStore (Vault/AWS/GCP/...)
    kind: ClusterSecretStore
  target:
    name: argocd-ai-assistant-secret
    creationPolicy: Owner
    template:
      metadata:
        labels:
          app.kubernetes.io/part-of: argocd    # required for $secret:key lookup
      data:
        openai-api-key: "Bearer {{ .token }}"  # Bearer prefix required
  data:
    - secretKey: token
      remoteRef:
        key: secret/argocd/assistant           # path/key in your secret backend
        property: api-token
```

[Sealed Secrets](https://github.com/bitnami-labs/sealed-secrets) or SOPS work equally well - anything that keeps the plaintext out of Git and produces a Secret named `argocd-ai-assistant-secret` (labelled `app.kubernetes.io/part-of: argocd`) with an `openai-api-key` key. With this approach the **Helm chart never sees the token** - you do not set `configs.secret.extra` or pass the value to the chart at all.

### Alternative: argocd-secret

If you already secret-manage `argocd-secret` (as the [`argocd-saml`](https://github.com/saidsef/argocd-saml) deployment does), add the `openai-api-key` key there and reference it as `$openai-api-key`. Avoid the literal `configs.secret.extra` / `kubectl patch` forms outside throwaway clusters - they put the token in `values.yaml` (Git history) or on the command line (CI logs).

Once resolved, `argocd-server` injects the token into the `Authorization` header server-side, so it never reaches the browser - which is why this is preferred over the browser-readable `data.apiKey` in the [settings extension](settings.md).

## Security considerations

| Risk | Implication | Mitigation |
|------|-------------|------------|
| Secret at rest | base64, not encrypted, readable via `get secret` | etcd encryption-at-rest, restrict Secret RBAC |
| Token in `values.yaml` | committed to Git history (GitOps) | ESO / Sealed Secrets / SOPS labelled Secret, never commit |
| Token via `kubectl patch` | leaks to shell history / CI logs / argv | apply a managed Secret, not an inline patch |
| `data.apiKey` in settings | readable by every UI user (browser) | use proxy injection, not the browser field |
| `argocd-cm` write access | repoint `services[].url` -> token exfil + SSRF | restrict config / GitOps write, review changes |
| `invoke` RBAC = all `readonly` | any user can spend the key / egress data | scope `invoke` to specific roles |
| `EXTENSION_URL` not pinned | MITM / compromise -> arbitrary JS in the UI | pin `EXTENSION_CHECKSUM`, HTTPS, trusted host |
| External provider key | billing abuse / data egress | scope + spend-limit + rotate, prefer in-cluster LLM |
| Transport to backend | cleartext token if not TLS | HTTPS, inject CA for self-signed |

## Enabling the proxy extension

The proxy extension must be enabled on `argocd-server`.

**Via Argo CD Operator `extraCommandArgs`:**

```yaml
spec:
  server:
    extraCommandArgs:
      - "--enable-proxy-extension"
```

**Via Helm chart `configs.cm` parameters:**

```yaml
configs:
  cm:
    params:
      server.enable.proxy.extension: 'true'
```

**Via raw manifests (`argocd-cmd-params-cm`):**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cmd-params-cm
  namespace: argocd
data:
  server.enable.proxy.extension: "true"
```

## RBAC requirements

Users must be allowed to invoke the `assistant` proxy extension. Add the policy:

```
p, role:readonly, extensions, invoke, assistant, allow
```

This grants the `readonly` role (and above) access to the Assistant. Apply it through your install method:

**Operator:**

```yaml
spec:
  rbac:
    policy: |
      g, system:cluster-admins, role:admin
      p, role:readonly, extensions, invoke, assistant, allow
```

**Helm (`values.yaml`):**

```yaml
configs:
  rbac:
    policy.default: role:readonly
    policy.csv: |
      p, role:readonly, extensions, invoke, assistant, allow
```

**Raw manifests (`argocd-rbac-cm`):**

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

## Proxy with TLS

If your LLM backend uses HTTPS with a self-signed certificate, inject the CA certificate into the Argo CD server pod:

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
