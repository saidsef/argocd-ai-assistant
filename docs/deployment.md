# Deployment Guide

This guide covers how to build, package, host, and deploy the Argo CD AI Assistant extension into an Argo CD instance.

## Table of Contents

1. [How It Works](#how-it-works)
2. [Prerequisites](#prerequisites)
3. [Build and Package](#build-and-package)
4. [Host the Extension](#host-the-extension)
5. [Configure Argo CD](#configure-argo-cd)
6. [RBAC Requirements](#rbac-requirements)
7. [Settings Extension](#settings-extension)
8. [Proxy Extension Configuration](#proxy-extension-configuration)
9. [Verification](#verification)
10. [Troubleshooting](#troubleshooting)

---

## How It Works

Argo CD supports UI extensions via the [Extension Installer](https://argo-cd.readthedocs.io/en/stable/developer-guide/extensions/proxy-extensions/) mechanism. The extension is delivered as a compressed tar archive containing JavaScript bundles. On startup, Argo CD's `argocd-server` pod runs an initContainer that downloads the extension archive and extracts it into `/tmp/extensions/`. The extension then registers itself with the Argo CD UI via the global `extensionsAPI`.

The AI Assistant extension communicates with your LLM backend through the Argo CD **Proxy Extension**. This avoids CORS issues by routing all backend traffic through the Argo CD server.

```
User Browser -> Argo CD UI -> Extension JS
                                    |
                                    v
                           Argo CD Proxy Extension
                                    |
                                    v
                              LLM Backend (Local Inference Server/vLLM/OpenAI)
```

---

## Prerequisites

- Argo CD >= v2.13
- Argo CD server deployed with the `--enable-proxy-extension` flag
- A running LLM backend with an OpenAI-compatible API
- (Optional) `oc` or `kubectl` CLI access to the cluster

---

## Build and Package

### Automated Release (Recommended)

The repository includes a GitHub Actions workflow that handles versioning, building, packaging, tagging, and releasing automatically.

When a change is merged to `main` and the CI workflow passes, the release workflow:

1. Analyzes the diff since the last tag and classifies the change as **major**, **minor**, or **patch**
2. Increments the version accordingly and creates an annotated Git tag
3. Builds and packages the extension
4. Publishes a GitHub Release with the extension tar as an asset and auto-generated release notes

No manual version bumping is required. Find the latest release tag on the [GitHub Releases page](https://github.com/saidsef/argocd-ai-assistant/releases) and use it in place of the `<version>` placeholder in the examples below.

### Manual Build

If you are building from source locally:

```shell
# Clone the repository
git clone https://github.com/saidsef/argocd-ai-assistant.git
cd argocd-ai-assistant

# Install dependencies (requires --force due to React peer dependency quirks)
yarn install --force

# Production build + package with a specific version
VERSION=0.5.9 yarn run package
```

This produces a tar archive at:

```
dist/extension-argocd-ai-assistant-<version>.tar
```

The `VERSION` environment variable overrides the placeholder version in `package.json`. If omitted, the build falls back to `package.json` version.

---

## Host the Extension

The Argo CD Extension Installer downloads the extension tar from a URL during pod initialization. Use the GitHub Release asset URL:

```
https://github.com/saidsef/argocd-ai-assistant/releases/download/v<version>/extension-argocd-ai-assistant-v<version>.tar
```

Replace `<version>` with the latest release tag (e.g., `v0.5.9`).

If you cannot use GitHub Releases, host the tar file on an internal artifact server, S3 bucket, or HTTP server accessible from the cluster.

---

## Configure Argo CD

### Argo CD Operator (OpenShift / Kubernetes)

If you deployed Argo CD using the [Argo CD Operator](https://argocd-operator.readthedocs.io/), add the following to your `ArgoCD` custom resource:

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
            value: "https://github.com/saidsef/argocd-ai-assistant/releases/download/v0.5.9/extension-argocd-ai-assistant-v0.5.9.tar"
        volumeMounts:
          - name: extensions
            mountPath: /tmp/extensions/
    volumes:
      - name: extensions
        emptyDir: {}
```

### Helm Chart

If you deployed Argo CD using the [community Helm chart](https://github.com/argoproj/argo-helm), add the configuration to your `values.yaml`:

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
          value: "https://github.com/saidsef/argocd-ai-assistant/releases/download/v0.5.9/extension-argocd-ai-assistant-v0.5.9.tar"
      volumeMounts:
        - name: extensions
          mountPath: /tmp/extensions/
  volumes:
    - name: extensions
      emptyDir: {}
```

**Alternative: using the chart's built-in `extensions` block**

The Helm chart provides a dedicated `server.extensions` block that manages the initContainer for you:

```yaml
server:
  extensions:
    enabled: true
    extensionList:
      - name: argocd-ai-assistant
        env:
          - name: EXTENSION_URL
            value: "https://github.com/saidsef/argocd-ai-assistant/releases/download/v0.5.9/extension-argocd-ai-assistant-v0.5.9.tar"
```

### Raw Kubernetes Manifests

If you manage Argo CD with raw manifests, patch the `argocd-cm` ConfigMap and the `argocd-server` Deployment:

**ConfigMap (`argocd-cm`):**

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

**Deployment (`argocd-server`):**

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
              value: "https://github.com/saidsef/argocd-ai-assistant/releases/download/v0.5.9/extension-argocd-ai-assistant-v0.5.9.tar"
          volumeMounts:
            - name: extensions
              mountPath: /tmp/extensions/
      containers:
        - name: argocd-server
          args:
            - /usr/local/bin/argocd-server
            - --enable-proxy-extension
      volumes:
        - name: extensions
          emptyDir: {}
```

---

## RBAC Requirements

The extension uses the Argo CD Proxy Extension to communicate with the LLM backend. Users must have permission to invoke proxy extensions. Add the following RBAC policy:

```
p, role:readonly, extensions, invoke, assistant, allow
```

This allows all users with the `readonly` role (and above) to use the Assistant. Adjust the role as needed for your environment.

### Configuring RBAC

**Via Argo CD Operator:**

```yaml
spec:
  rbac:
    policy: |
      g, system:cluster-admins, role:admin
      p, role:readonly, extensions, invoke, assistant, allow
```

**Via Helm (`values.yaml`):**

```yaml
configs:
  rbac:
    policy.default: role:readonly
    policy.csv: |
      p, role:readonly, extensions, invoke, assistant, allow
```

**Via ConfigMap (`argocd-rbac-cm`):**

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

---

## Settings Extension

The Assistant requires configuration to know which LLM backend to use. Since Argo CD extensions do not have a native configuration mechanism, settings are deployed as a **second extension** that sets `globalThis.argocdAssistantSettings`.

### 1. Create a Settings File

Create a JavaScript file named `extension-settings.js`:

```javascript
globalThis.argocdAssistantSettings = {
    provider: "LLM",
    model: "gpt-4",
    data: {
        baseURL: "http://local.local.svc.cluster.local:11434/v1"
    }
};

(() => {
    console.log("Initializing Argo CD AI Assistant Settings");
})();
```

**Important settings:**

| Setting | Required | Description |
|---------|----------|-------------|
| `provider` | Yes | Must be `"LLM"`. |
| `model` | No | Model name (e.g., `gpt-4`, `gpt-4`). |
| `data.baseURL` | No | OpenAI-compatible API base URL. Defaults to Argo CD proxy if omitted. |
| `data.apiKey` | No | API key for authentication (OpenAI, Azure, etc.). |
| `maximumLogLines` | No | Max log lines attachable (default: 250). |

### 2. Package the Settings Extension

The settings extension must be in its own directory within the tar archive:

```shell
mkdir -p resources/argocd-ai-assistant-settings
cp extension-settings.js resources/argocd-ai-assistant-settings/
tar -cvf argocd-ai-assistant-settings.tar resources
```

### 3. Host and Deploy the Settings Extension

There are two ways to deploy the settings extension:

#### Option A: Second initContainer (tar archive)

Package the settings as a tar archive, host it on a reachable URL, and add a second initContainer:

```yaml
initContainers:
  - name: extension-argocd-ai-assistant
    image: quay.io/argoprojlabs/argocd-extension-installer:v1.0.0
    securityContext:
      allowPrivilegeEscalation: false
    env:
      - name: EXTENSION_URL
        value: "https://github.com/saidsef/argocd-ai-assistant/releases/download/v0.5.9/extension-argocd-ai-assistant-v0.5.9.tar"
    volumeMounts:
      - name: extensions
        mountPath: /tmp/extensions/
  - name: extension-argocd-ai-assistant-settings
    image: quay.io/argoprojlabs/argocd-extension-installer:v1.0.0
    securityContext:
      allowPrivilegeEscalation: false
    env:
      - name: EXTENSION_URL
        value: "https://your-host/argocd-ai-assistant-settings.tar"
    volumeMounts:
      - name: extensions
        mountPath: /tmp/extensions/
```

#### Option B: ConfigMap volume mount (recommended)

Create a ConfigMap containing the settings JavaScript file, then mount it directly into the Argo CD server pod. This avoids hosting a second tar archive and is simpler to manage with GitOps.

**ConfigMap:**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-ai-assistant-settings
data:
  extension-settings.js: |
    globalThis.argocdAssistantSettings = {
        provider: "LLM",
        model: "deepseek-v4-flash",
        data: {
            baseURL: "https://api.deepseek.com/v1"
        }
    };
    (() => { console.log("Argo CD AI Assistant Settings loaded"); })();
```

**Server volumes and volumeMounts:**

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

**Note:** Never put API keys directly in the settings JS file if it will be hosted publicly. The file is readable in the browser. Instead:
- Inject the API key via a Kubernetes Secret mounted as an environment variable and referenced in the JS.
- Or use a backend proxy (like the Argo CD Proxy Extension) that handles authentication via `headers` in `extension.config.assistant`.

---

## Proxy Extension Configuration

The `extension.config.assistant` block in the ConfigMap tells the Argo CD Proxy Extension where to forward LLM requests.

### Example: Local Inference Server in-cluster

```yaml
extension.config.assistant: |
  connectionTimeout: 2s
  keepAlive: 360s
  idleConnectionTimeout: 360s
  maxIdleConnections: 30
  services:
  - url: http://local.local.svc.cluster.local:11434
```

### Example: vLLM in-cluster

```yaml
extension.config.assistant: |
  connectionTimeout: 2s
  keepAlive: 360s
  idleConnectionTimeout: 360s
  maxIdleConnections: 30
  services:
  - url: http://vllm.vllm.svc.cluster.local:8000
```

### Example: OpenAI / DeepSeek (external) with proxy headers

If using an external provider, it is recommended to route through the proxy and inject the Authorization header server-side so the API key never reaches the browser.

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
      value: '$openai-api-key'
```

!!! important "Secret value must include the `Bearer` prefix"
    The `$` prefix is required for Argo CD template injection — without it the value is treated as a literal string. The placeholder `$openai-api-key` is resolved from an environment variable or secret configured on the Argo CD server.

    **The secret value itself must include the `Bearer ` prefix** (e.g. `Bearer sk-xxxx`). The proxy is a generic reverse proxy: it performs raw string substitution and does not inspect, validate, or transform headers. If the secret contains only the token (`sk-xxxx`), the proxy forwards `Authorization: sk-xxxx` verbatim, which the LLM backend rejects as malformed. Store the full header value:

    ```
    Bearer sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    ```

    This keeps the API key out of the browser, the settings JavaScript file, and any ConfigMap.

If using OpenAI or another external provider, you may not need the proxy extension at all if the provider is CORS-enabled and reachable directly. However, for security and to avoid exposing API keys to the browser, it is recommended to route through the proxy or use a backend gateway.

### Proxy Extension with TLS

If your LLM backend uses HTTPS with a self-signed certificate, you must inject the CA certificate into the Argo CD server pod:

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

---

## Verification

After applying the configuration, wait for the Argo CD server pod to restart (the Operator or Deployment rollout will handle this).

1. **Check the initContainer logs:**

```shell
kubectl logs -n argocd deployment/argocd-server -c extension-argocd-ai-assistant
```

You should see output indicating the extension was downloaded and extracted successfully.

2. **Verify the extension files are present:**

```shell
kubectl exec -n argocd deployment/argocd-server -c argocd-server -- ls -la /tmp/extensions/resources/extensions-argocd-ai-assistant/
```

3. **Open the Argo CD UI**, navigate to any Application, click on a resource, and verify the **Assistant** tab appears.

4. **Test a query:** Ask a question about the resource. The chatbot should stream a response.

---

## Troubleshooting

### The Assistant tab does not appear

- Verify the initContainer ran successfully: `kubectl logs -n argocd deployment/argocd-server -c extension-argocd-ai-assistant`
- Check that the extension JS file exists in the pod: `kubectl exec ... -- ls /tmp/extensions/resources/extensions-argocd-ai-assistant/`
- Ensure the `--enable-proxy-extension` flag is passed to the argocd-server.

### "Unexpected Error: No models are configured"

- Verify the settings extension is loaded and `globalThis.argocdAssistantSettings` is set.
- Check the browser console for JS errors.
- Ensure the `baseURL` in settings is correct and reachable from the Argo CD server pod.

### Streaming does not work / responses are buffered

- Verify your Argo CD version supports proxy extensions with streaming (requires Argo CD >= v2.13).
- Check that the proxy extension configuration includes a reasonable `connectionTimeout` and that the LLM backend supports streaming.

### CORS errors in the browser console

- This indicates traffic is not going through the proxy extension. Ensure the `baseURL` in settings points to the proxy path (or omit it to use the default proxy behavior).

### RBAC errors

- Ensure the RBAC policy `p, role:readonly, extensions, invoke, assistant, allow` is configured.
- Verify the user has a role that includes this permission.
