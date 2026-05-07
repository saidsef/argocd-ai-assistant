# argocd-ai-assistant [![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE.md)

An Argo CD UI Extension that adds an AI-powered Assistant chatbot to the Argo CD interface. It registers as a Resource Tab Extension, allowing users to ask questions about the currently selected Kubernetes resource. The extension automatically attaches the resource manifest and events to the query context, and optionally includes container logs via a guided conversation flow.

## What does it do?

The Assistant for Argo CD adds an **Assistant** tab to Argo CD's resource view. When a user opens the tab, they can ask questions about the selected resource in natural language. The extension enriches each query with contextual data:

1. **Resource Manifest** — the live Kubernetes resource object provided by Argo CD.
2. **Events** — automatically fetched from the Argo CD API and attached to the query.
3. **Logs** (optional) — fetched via a guided flow for resources with containers (Pod, Deployment, StatefulSet, Job, Rollout).

## Supported Backends

The extension uses a single, generic LLM provider that communicates via the **OpenAI-compatible chat completions API**. This means it works with virtually any inference backend.

Communication with the backend is proxied through the Argo CD server using the [Proxy Extension](https://argo-cd.readthedocs.io/en/stable/developer-guide/extensions/proxy-extensions/) feature to avoid CORS issues.

| Backend | Type |
|---------|------|
| Local Inference Server | Local inference |
| [vLLM](https://github.com/vllm-project/vllm) | High-throughput serving |
| [OpenAI](https://openai.com/) | Cloud API |
| [Azure OpenAI](https://azure.microsoft.com/en-us/products/ai-services/openai-service/) | Managed service |
| Any other OpenAI-compatible endpoint | — |

## Prerequisites

- [Argo CD](https://argo-cd.readthedocs.io/en/stable/) >= v2.13
- A running LLM backend with an OpenAI-compatible API accessible from the Argo CD server

## Development

```shell
# Install dependencies (requires --force due to React peer dependency quirks)
yarn install --force

# Production build
yarn run build

# Development build
yarn run build-dev
```

## Release

Releases are handled automatically via GitHub Actions. When a change is merged to `main` and the CI workflow passes, the release workflow:

1. Analyzes the diff since the last tag to classify the change as **major**, **minor**, or **patch**
2. Increments the version accordingly and creates an annotated Git tag
3. Builds and packages the extension
4. Publishes a GitHub Release with the extension tar asset and auto-generated release notes

No manual version bumping is required.

## Deployment

See the [Deployment Guide](docs/deployment.md) for step-by-step instructions on building, packaging, hosting, and installing the extension into Argo CD via the Extension Installer.

## Documentation

Full documentation is in the [`docs/`](./docs) directory and built with [MkDocs Material](https://squidfunk.github.io/mkdocs-material/).

## Source

Our latest source can be found on [GitHub](https://github.com/saidsef/argocd-ai-assistant). Fork us!

## Contributing

We would love you to contribute by making a [pull request](https://github.com/saidsef/argocd-ai-assistant/pulls).

Please read the official [Contribution Guide](./CONTRIBUTING.md) for more information on how you can contribute.
