# Argo CD AI Assistant

The Argo CD AI Assistant is a UI extension that adds an AI chatbot to the Argo CD interface. It registers as a Resource Tab Extension, providing an "Assistant" tab on every resource slide-out panel so users can ask questions about live manifests, events, and logs.

## Features

- **Per-Resource Chat** - Ask questions about any Kubernetes resource directly from its detail panel.
- **Context-Aware** - Automatically attaches the resource manifest, events, and optional container logs to every query.
- **Generic LLM Backend** - Works with any OpenAI-compatible API (Ollama, vLLM, OpenAI, Azure, DeepSeek, etc.).
- **Streaming Responses** - Real-time streaming replies via Server-Sent Events (SSE).
- **Proxy Extension** - All backend traffic is routed through the Argo CD server to avoid CORS and keep API keys out of the browser.
- **Theme-Aware UI** - Chat bubble colours adapt automatically to Argo CD's light and dark themes.
- **MCP Integration (Experimental)** - Optional system-level extension for MCP server token provisioning, gated by the `mcp-for-argocd` feature flag.

## Quick Links

- [Architecture](architecture.md) - How the extension is structured and communicates.
- [Deployment](deployment.md) - Build, package, host, and deploy the extension.
- [LLM Provider](providers/llm.md) - Configure the generic OpenAI-compatible provider.

## Repository

Source code and releases: [github.com/saidsef/argocd-ai-assistant](https://github.com/saidsef/argocd-ai-assistant)
