### LLM Provider

The LLM provider uses the standard OpenAI-compatible chat completions API. This allows it to work with any inference backend that supports the OpenAI API format, including:

- **Ollama** — Local inference with `ollama serve`
- **vLLM** — High-throughput inference engine
- **OpenAI** — OpenAI's official API
- **Azure OpenAI** — Microsoft's hosted OpenAI service
- **Any OpenAI-compatible endpoint**

### Configuration

The LLM provider requires minimal configuration. The key settings are:

| Setting | Required | Description |
|---------|----------|-------------|
| `baseURL` | No | The base URL of the OpenAI-compatible API. Defaults to `https://<argo-host>/extensions/assistant` (via Argo CD proxy). |
| `apiKey` | No | API key for authentication. Required for cloud providers like OpenAI or Azure. |
| `model` | No | The model to use. If omitted, the provider may use a default model. |

### Example Settings

#### Ollama (in-cluster)
```javascript
var argocdAssistantSettings = {
    provider: "LLM",
    model: "llama3.2",
    data: {
        baseURL: "http://ollama.ollama.svc.cluster.local:11434/v1"
    }
};
```

#### OpenAI
```javascript
var argocdAssistantSettings = {
    provider: "LLM",
    model: "gpt-4",
    data: {
        baseURL: "https://api.openai.com/v1"
        // apiKey should be injected via a mounted Secret or backend proxy
    }
};
```

#### Via Argo CD Proxy Extension
```javascript
var argocdAssistantSettings = {
    provider: "LLM",
    model: "my-model",
    data: {
        baseURL: "/extensions/assistant/v1"
    }
};
```

### Installation

Install the extension into the Argo CD instance by adding the following in the appropriate spots, note here we are using
the Argo CD Operator but feel free to adapt it for the `argocd-cm` ConfigMap if you have deployed Argo CD using the Helm chart.

Replace `<version>` with the latest release tag from the [GitHub Releases page](https://github.com/saidsef/argocd-ai-assistant/releases):

```yaml
apiVersion: argoproj.io/v1beta1
kind: ArgoCD
metadata:
  name: openshift-gitops
  namespace: openshift-gitops
spec:
  rbac:
    ...
    p, role:readonly, extensions, invoke, assistant, allow
  extraConfig:
    extension.config.assistant: |
      connectionTimeout: 2s
      keepAlive: 360s
      idleConnectionTimeout: 360s
      maxIdleConnections: 30
      services:
        # Adjust this URL to wherever your LLM backend is running.
      - url: http://llm-backend.llm.svc.cluster.local:8080
  server:
    extraCommandArgs:
      - "--enable-proxy-extension"
    initContainers:
      - env:
          - name: EXTENSION_URL
            value: "https://github.com/saidsef/argocd-ai-assistant/releases/download/v<version>/extension-argocd-ai-assistant-<version>.tar"
        image: "quay.io/argoprojlabs/argocd-extension-installer:v0.0.8"
        name: extension-argocd-ai-assistant
        securityContext:
          allowPrivilegeEscalation: false
        volumeMounts:
          - name: extensions
            mountPath: /tmp/extensions/
    volumes:
      - name: extensions
        emptyDir: {}
```
