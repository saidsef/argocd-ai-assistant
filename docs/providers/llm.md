### LLM Provider

The LLM provider uses the standard OpenAI-compatible chat completions API. This allows it to work with any inference backend that supports the OpenAI API format, including:

- **Local Inference Server** - Self-hosted local inference (e.g. Ollama)
- **vLLM** - High-throughput inference engine
- **OpenAI** - OpenAI's official API
- **Azure OpenAI** - Microsoft's hosted OpenAI service
- **Any OpenAI-compatible endpoint**

### Configuration

The LLM provider requires minimal configuration. The key settings are:

| Setting | Required | Description |
|---------|----------|-------------|
| `provider` | Yes | Must be `"LLM"`. |
| `model` | Recommended | The model name (e.g. `gpt-4`). If omitted, queries fail with `LLM model is not configured`. |
| `data.baseURL` | No | Base URL of the OpenAI-compatible API. Defaults to `https://<argo-host>/extensions/assistant` (via the Argo CD proxy). |
| `data.apiKey` | No | API key sent from the browser (raw token; the provider adds the `Bearer ` prefix if missing). Browser-readable - for production, inject it server-side via the proxy instead: see [Injecting the API token](../deployment/proxy.md#injecting-the-api-token). |
| `data.mcpServers` | No | Array of MCP server HTTP endpoints. See [MCP Tool Integration](../architecture.md#mcp-tool-integration). |
| `maximumLogLines` | No | Max log lines attachable (default: 250). |
| `systemPrompt` | No | Overrides the built-in assistant persona/instructions. Defaults to an Argo CD / Kubernetes expert prompt that grounds answers in the attached manifest, events, and logs. |

`baseURL`, `apiKey`, and `mcpServers` live under the `data` object; `provider`, `model`, `maximumLogLines`, and `systemPrompt` are top-level. See the [Settings Extension](../deployment/settings.md) page for how to deploy these settings.

### Example Settings

#### Local Inference Server (in-cluster)
```javascript
globalThis.argocdAssistantSettings = {
    provider: "LLM",
    model: "gpt-4",
    data: {
        baseURL: "http://local.local.svc.cluster.local:11434/v1"
    }
};
```

#### OpenAI / DeepSeek
```javascript
globalThis.argocdAssistantSettings = {
    provider: "LLM",
    model: "gpt-4",
    data: {
        baseURL: "https://api.openai.com/v1"
        // Do not put the key here - it is readable in the browser. Inject it
        // server-side via the proxy instead (see Injecting the API token).
    }
};
```

#### Via Argo CD Proxy Extension
```javascript
globalThis.argocdAssistantSettings = {
    provider: "LLM",
    model: "deepseek-chat",
    data: {
        baseURL: "/extensions/assistant"
    }
};
```

#### With Custom Log Limit
```javascript
globalThis.argocdAssistantSettings = {
    provider: "LLM",
    model: "gpt-4",
    data: {
        baseURL: "http://local.local.svc.cluster.local:11434/v1"
    },
    maximumLogLines: 500
};
```

### Installing the Extension

See the [Deployment Guide](../deployment.md) for full installation instructions, including Helm, Operator, and raw manifest examples.
