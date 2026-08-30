# Argo CD AI Assistant

The Argo CD AI Assistant is a UI extension that adds an AI chatbot to the Argo CD interface. It registers as a Resource Tab Extension, providing an "Assistant" tab on every resource slide-out panel so users can ask questions about live manifests, events, and logs.

## Features

- **Per-Resource Chat** - Ask questions about any Kubernetes resource directly from its detail panel.
- **Context-Aware** - Automatically attaches the resource manifest, a distilled Argo CD Application summary, events, and optional container logs to every query.
- **Generic LLM Backend** - Works with any OpenAI-compatible API (Ollama, vLLM, OpenAI, Azure, DeepSeek, etc.). A backend serving one model needs no settings at all: the name comes from its `/v1/models`.
- **Streaming Responses** - Real-time streaming replies via Server-Sent Events (SSE).
- **Proxy Extension** - All backend traffic is routed through the Argo CD server to avoid CORS and keep API keys out of the browser.
- **Theme-Aware UI** - Chat bubble colours adapt automatically to Argo CD's light and dark themes.
- **MCP Integration (Experimental)** - Optional Model Context Protocol tool support: configure `data.mcpServers` and the assistant calls a server's tools when you name that server in your message, with an optional per-user Argo CD token sent to those servers as an `Authorization: Bearer` credential.

## Quick Links

- [Architecture](architecture.md) - How the extension is structured and communicates.
- [Deployment](deployment.md) - Build, package and host the extension.
- Install - [Argo CD Operator](deployment/operator.md), [Helm chart](deployment/helm.md) or [raw manifests](deployment/raw.md), a page each.
- [Settings Extension](deployment/settings.md) - Pin a model, change the prompt, add MCP servers.

## Repository

Source code and releases: [github.com/saidsef/argocd-ai-assistant](https://github.com/saidsef/argocd-ai-assistant)
