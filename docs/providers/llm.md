### LLM Provider

The LLM provider uses the standard OpenAI-compatible chat completions API. This allows it to work with any inference backend that supports the OpenAI API format, including:

- **Local Inference Server** — Local inference with `local inference server`
- **vLLM** — High-throughput inference engine
- **OpenAI** — OpenAI's official API
- **Azure OpenAI** — Microsoft's hosted OpenAI service
- **Any OpenAI-compatible endpoint**

### Configuration

The LLM provider requires minimal configuration. The key settings are:

| Setting | Required | Description |
|---------|----------|-------------|
| `baseURL` | No | The base URL of the OpenAI-compatible API. Defaults to `https://<argo-host>/extensions/assistant` (via Argo CD proxy). |
| `apiKey` | No | API key for authentication. Required for cloud providers like OpenAI or Azure. **Raw token only** (e.g. `sk-xxxx`) — the provider code prepends `Bearer `. |
| `model` | No | The model to use. If omitted, the provider may use a default model. |

### Example Settings

#### Local Inference Server (in-cluster)
```javascript
var argocdAssistantSettings = {
    provider: "LLM",
    model: "gpt-4",
    data: {
        baseURL: "http://local.local.svc.cluster.local:11434/v1"
    }
};
```

#### OpenAI / DeepSeek
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
    model: "deepseek-v4-flash",
    data: {
        baseURL: "/extensions/assistant/v1"
    }
};
```

### Installing the Extension

See the [Deployment Guide](../deployment.md) for full installation instructions, including Helm, Operator, and raw manifest examples.
