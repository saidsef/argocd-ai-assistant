# Proxy & Backend Configuration

The Assistant talks to your LLM through the Argo CD **Proxy Extension**, which routes browser traffic through `argocd-server` (avoiding CORS and keeping API keys out of the browser). This page covers where the proxy forwards requests, how to enable it, and the RBAC needed to invoke it.

The `extension.config.assistant` block tells the proxy where to forward requests. Where you put it depends on your install method - see [Operator](operator.md), [Helm](helm.md), or [Raw manifests](raw.md) - but the value is the same.

!!! important "The name `assistant` is not yours to choose"
    The browser asks for `/extensions/assistant`, and that path is compiled into the extension rather than read from settings. Three things have to spell it the same way:

    - `extension.config.assistant`, wherever your install method puts it
    - `assistant` in `p, role:readonly, extensions, invoke, assistant, allow`
    - `/extensions/assistant`, the path the browser requests

    Name the proxy extension after your backend instead and everything looks fine until someone asks a question: the UI loads, the tab appears, and the first request comes back 404.

## Backend examples

Only `services[].url` is required. Point it at anything that speaks the OpenAI API:

```yaml
extension.config.assistant: |
  services:
  - url: http://vllm.vllm.svc.cluster.local:8000
```

An in-cluster Ollama is `http://local.local.svc.cluster.local:11434` instead. Both take the plain root - the extension appends `/v1/chat/completions` itself.

### An external provider

For OpenAI, DeepSeek or anything else off-cluster, keep the traffic on the proxy and have it add the `Authorization` header, so the API key never reaches the browser:

```yaml
extension.config.assistant: |
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

### Tuning the connection

The proxy has four timeout settings and every one of them has a default, so leave them out until something makes you want them. A model that takes a while to produce its first token is the usual reason - raise `keepAlive` and `idleConnectionTimeout` and the stream survives the wait:

```yaml
extension.config.assistant: |
  keepAlive: 360s
  idleConnectionTimeout: 360s
  services:
  - url: http://vllm.vllm.svc.cluster.local:8000
```

| Key | Default | What it covers |
|-----|---------|----------------|
| `connectionTimeout` | 2s | opening the connection to the backend |
| `keepAlive` | 15s | how long an open connection is held |
| `idleConnectionTimeout` | 60s | how long an idle connection is kept in the pool |
| `maxIdleConnections` | 30 | size of that pool |

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

!!! note "The proxy authorises per Application"
    Every proxied request carries `Argocd-Application-Name` and `Argocd-Project-Name`, and Argo CD checks the user against that Application - so users also need read access to the Application they are asking about. `role:readonly` already covers this. The system-level `/assistant` page has no Application of its own and borrows the first one the user can read, so a role scoped to *no* Applications can use the resource tab (via the resource's own Application) but not the system-level page.

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
