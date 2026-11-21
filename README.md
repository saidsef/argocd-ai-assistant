# argocd-ai-assistant [![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE.md)

An Argo CD UI extension that adds an **Assistant** tab to the resource panel. Ask about a resource in plain language, and the Assistant answers from its live state. With each question it sends the manifest, a summary of the owning Application, events, pod states and, for an OutOfSync resource, any fields that differ from Argo CD's target state. A user can also attach a container's logs.

It works with any backend that speaks the OpenAI-compatible chat completions API, such as Ollama, [vLLM](https://github.com/vllm-project/vllm), OpenAI, Azure OpenAI, DeepSeek or Anthropic's [OpenAI-compatible endpoint](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk). Requests go through Argo CD's [proxy extension](https://argo-cd.readthedocs.io/en/stable/developer-guide/extensions/proxy-extensions/), which keeps the API key on the server.

## Installation

[Deployment](docs/deployment.md) lists the prerequisites and links to an install page for the Argo CD Operator, the Helm chart and raw manifests. A backend that serves one model works without further settings. [Settings extension](docs/deployment/settings.md) covers the model, the prompt and MCP servers.

## MCP tool servers

The Assistant can call tools on [MCP](https://modelcontextprotocol.io/) servers listed in `data.mcpServers`. A question uses a server's tools only when it names the server:

```text
docs, what does a sync wave do?
```

[MCP servers](docs/deployment/settings.md#mcp-servers) covers the configuration, including which servers receive the user's Argo CD token. [Architecture](docs/architecture.md#mcp-servers) covers the behaviour.

## Development

```shell
yarn install --frozen-lockfile
yarn typecheck
yarn test
yarn build-dev    # development build in dist/
yarn package      # production build and dist/extension-argocd-ai-assistant.tar
```

[Local testing with kind](docs/deployment/local-testing.md) installs the extension from your working tree on a throwaway cluster:

```shell
./examples/kind/setup.sh raw    # or helm, operator
```

## Documentation

The [documentation site](https://argocd-ai-assistant.readthedocs.io/) is built from [`docs/`](docs) with MkDocs Material.

## Contributing

See the [contribution guide](CONTRIBUTING.md).
