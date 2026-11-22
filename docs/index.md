# Argo CD AI Assistant

The Argo CD AI Assistant adds an **Assistant** tab to the resource panel in Argo CD. Users ask about a resource in plain language, and the Assistant answers from that resource's live state.

## Features

- Each question carries the live manifest, a summary of the owning Application, events, pod states and, for an OutOfSync resource, the fields that differ from Argo CD's target state. A user can also attach a container's logs.
- Any backend with an OpenAI-compatible chat completions API works, such as Ollama, vLLM, OpenAI, Azure OpenAI or DeepSeek. A backend that serves one model does not need any settings.
- Requests go through Argo CD's proxy extension, which keeps the API key on the server.
- Replies stream as the model writes them, in Argo CD's light or dark theme.
- Built-in tools let the model read other resources, logs, recent deployments and drift in the same Application, with the user's own Argo CD permissions.
- MCP servers can give the model more tools, which a question uses only when it names the server.

## Where to start

- [Deployment](deployment.md) for prerequisites, install methods and release artefacts.
- [Settings extension](deployment/settings.md) for the model, prompt and MCP servers.
- [Proxy and backend](deployment/proxy.md) for backends, API keys, timeouts and RBAC.
- [Verification and troubleshooting](deployment/verification.md) to confirm it works.
- [Architecture](architecture.md) for what the Assistant sends and how it uses tools.

The source and releases are on [GitHub](https://github.com/saidsef/argocd-ai-assistant).
