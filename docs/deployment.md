# Deployment

The extension is a tar of JavaScript that Argo CD's extension installer downloads into `argocd-server` when the pod starts. The browser then reaches the LLM backend through Argo CD's proxy extension at `/extensions/assistant`. [Architecture](architecture.md) shows the whole path.

## Prerequisites

- Argo CD v2.13 or later, with the proxy extension enabled on `argocd-server`.
- An LLM backend with an OpenAI-compatible API that `argocd-server` can reach.
- A browser that supports CSS nesting and `AbortSignal.any`: Chrome or Edge 116, Safari 17.4, Firefox 124, or later.

## Install methods

Each page is a complete install for one way of running Argo CD.

| Argo CD installed with | Page |
|---|---|
| The `ArgoCD` custom resource, from argocd-operator or OpenShift GitOps | [Argo CD Operator](deployment/operator.md) |
| The community `argo/argo-cd` Helm chart | [Helm chart](deployment/helm.md) |
| Argo CD's own `install.yaml` | [Raw manifests](deployment/raw.md) |

Every method sets up the same five things:

1. The proxy extension flag on `argocd-server`.
2. A proxy target named `assistant` that points at the LLM backend.
3. An RBAC policy that lets users invoke the `assistant` extension.
4. An installer initContainer that extracts the extension into a volume that `argocd-server` also mounts.
5. Optionally, a settings extension that names the model, replaces the prompt or adds MCP servers.

!!! warning "Server-side volume mount"
    The initContainer extracts the extension into an `emptyDir`, and `argocd-server` serves it only if its own container mounts that volume too. The Helm chart's `server.extensions` block adds both mounts. With the Operator and with raw manifests, the server-side mount is a separate entry. A missing server-side mount is the most common reason the Assistant tab does not appear.

## Release artefacts

Every merge to `main` that passes CI publishes a release with the extension tar. Pin a version in `EXTENSION_URL`:

```
https://github.com/saidsef/argocd-ai-assistant/releases/download/v<version>/extension-argocd-ai-assistant.tar
```

The [Releases page](https://github.com/saidsef/argocd-ai-assistant/releases) lists the versions. The `latest` alias, `releases/latest/download/extension-argocd-ai-assistant.tar`, follows each new release. An `argocd-server` restart can then load a build you have not reviewed.

A nightly job keeps the 50 newest releases and deletes older ones. The git tag of a deleted release remains, but its download URL stops working. Move a pin forward before it ages out, or host the tar yourself.

Releases do not publish a checksum. For a verified download, host the tar and a checksum file on a server you trust, and set `EXTENSION_CHECKSUM_URL` on the installer. [Security considerations](deployment/proxy.md#security-considerations) explains the risk.

## Building from source

```shell
git clone https://github.com/saidsef/argocd-ai-assistant.git
cd argocd-ai-assistant
yarn install --frozen-lockfile
yarn run package
```

`yarn run package` writes `dist/extension-argocd-ai-assistant.tar`. `VERSION` sets the version in the bundle's file name. Without it, the build takes its version from `package.json`. Host the tar where `argocd-server` can download it, and point `EXTENSION_URL` at it.

## After installing

- [Settings extension](deployment/settings.md) to name a model, replace the prompt or add MCP servers.
- [Proxy and backend](deployment/proxy.md) for external providers, API keys, timeouts and TLS.
- [Verification and troubleshooting](deployment/verification.md) to confirm the extension loads and answers.
- [Local testing with kind](deployment/local-testing.md) to try each install method on a throwaway cluster.
