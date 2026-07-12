### LLM Provider

The LLM provider uses the standard OpenAI-compatible chat completions API. This allows it to work with any inference backend that supports the OpenAI API format, including:

- **Local Inference Server** - Self-hosted local inference (e.g. Ollama)
- **vLLM** - High-throughput inference engine
- **OpenAI** - OpenAI's official API
- **Azure OpenAI** - Microsoft's hosted OpenAI service
- **Any OpenAI-compatible endpoint**

### Configuration

The provider needs only `provider: "LLM"` and a `model`, everything else is optional. `baseURL`, `apiKey`, and `mcpServers` live under the `data` object, the rest are top-level. The [Settings Extension](../deployment/settings.md#create-the-settings-file) page has the full field reference and how to deploy these settings.

### Example Settings

```javascript
globalThis.argocdAssistantSettings = {
    provider: "LLM",
    model: "gpt-4",
    data: {
        baseURL: "http://local.local.svc.cluster.local:11434/v1"
    }
};
```

Vary this for other setups:

- **Route through the Argo CD proxy** (recommended) - omit `data.baseURL` (it defaults to the proxy path) or set it to `/extensions/assistant`. Keeps API keys out of the browser.
- **External provider** (OpenAI/DeepSeek) - set `data.baseURL` to e.g. `https://api.openai.com/v1`. Do not put the key here, inject it server-side via the proxy (see [Injecting the API token](../deployment/proxy.md#injecting-the-api-token)).
- **Higher log limit** - add `maximumLogLines: 500` at the top level (default 250).

### Installing the Extension

See the [Deployment Guide](../deployment.md) for full installation instructions, including Helm, Operator, and raw manifest examples.
