# argocd-ai-assistant [![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE.md)

An Argo CD UI extension that adds an **Assistant** tab to the resource view. Open any Kubernetes resource, ask questions about it in natural language, and the extension enriches each query with context:

1. **Resource manifest** - the live object, provided by Argo CD.
2. **Events** - fetched from the Argo CD API and attached automatically.
3. **Logs** (optional) - from a single container, via a guided flow (Pod, Deployment, StatefulSet, Job, Rollout).

## Supported Backends

A single generic provider speaks the **OpenAI-compatible chat completions API**, so it works with any backend that does: a local inference server (e.g. Ollama), [vLLM](https://github.com/vllm-project/vllm), [OpenAI](https://openai.com/), [Azure OpenAI](https://azure.microsoft.com/en-us/products/ai-services/openai-service/), or any other OpenAI-compatible endpoint. Traffic is routed through the Argo CD [Proxy Extension](https://argo-cd.readthedocs.io/en/stable/developer-guide/extensions/proxy-extensions/) to avoid CORS.

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

Releases are automated: on merge to `main` (once CI passes), a workflow classifies the change, bumps the version, tags it, and publishes a GitHub Release with the extension tar. No manual version bumping. See [Build and Package](docs/deployment.md#build-and-package) for details.

## Deployment

See the [Deployment Guide](docs/deployment.md) for step-by-step instructions on building, packaging, hosting, and installing the extension into Argo CD via the Extension Installer. It covers the Argo CD Operator, the community Helm chart, and raw manifests.

### Local testing

To try the extension end to end on a throwaway [kind](https://kind.sigs.k8s.io/) cluster - with a built-in mock LLM, no GPU or API key required - use the harness in [`examples/kind/`](./examples/kind):

```shell
./examples/kind/setup.sh raw    # or: helm | operator
```

A successful run installs Argo CD, installs this extension built from source, and verifies the full path (including a streamed proxy request) with `== 8 passed, 0 failed ==`. See [`examples/kind/README.md`](./examples/kind/README.md).

## Documentation

Full documentation is in the [`docs/`](./docs) directory and built with [MkDocs Material](https://squidfunk.github.io/mkdocs-material/).

Live docs: [argocd-ai-assistant.readthedocs.io](https://argocd-ai-assistant.readthedocs.io/)

## Source

Source and releases: [github.com/saidsef/argocd-ai-assistant](https://github.com/saidsef/argocd-ai-assistant).

## Contributing

Pull requests welcome - see the [Contribution Guide](./CONTRIBUTING.md).
