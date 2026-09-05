# Deployment Guide

This guide covers how to build, package, host, and install the Argo CD AI Assistant extension into an Argo CD instance.

Each way of running Argo CD has its own install page, so you read one method and not three. The rest is shared reference:

- **Install:** [Argo CD Operator](deployment/operator.md) · [Helm chart](deployment/helm.md) · [Raw manifests](deployment/raw.md)
- **Configure:** [Settings Extension](deployment/settings.md) · [Proxy & Backend](deployment/proxy.md)
- **Test:** [Local Testing with kind](deployment/local-testing.md) · [Verification & Troubleshooting](deployment/verification.md)

---

## How It Works

Argo CD supports UI extensions via the [Extension Installer](https://argo-cd.readthedocs.io/en/stable/developer-guide/extensions/proxy-extensions/). The extension ships as a compressed tar of JavaScript bundles. On startup, an initContainer on the `argocd-server` pod downloads and extracts it into `/tmp/extensions/`, and the extension registers itself via the global `extensionsAPI`. All LLM traffic then flows through the Argo CD **Proxy Extension**, which routes it through `argocd-server` to avoid CORS. [Architecture](architecture.md) has the full picture, including the Argo CD API reads and the MCP path.

---

## Prerequisites

- Argo CD >= v2.13
- Argo CD server deployed with the `--enable-proxy-extension` flag (see [Proxy & Backend](deployment/proxy.md#enabling-the-proxy-extension))
- A running LLM backend with an OpenAI-compatible API. Serving one model, it needs no further configuration - the name is read from its `/v1/models`
- A browser supporting CSS nesting and `AbortSignal.any`: Chrome/Edge 116+, Safari 17.4+, Firefox 124+
- (Optional) `oc` or `kubectl` CLI access to the cluster

---

## Build and Package

### Use a release (recommended)

Releases are automated and a tag is cut on every merge, so take the version for `EXTENSION_URL` from the [Releases page](https://github.com/saidsef/argocd-ai-assistant/releases) rather than from a snippet on these pages, which is only ever current on the day it was written.

### Manual build

If you are building from source locally:

```shell
# Clone the repository
git clone https://github.com/saidsef/argocd-ai-assistant.git
cd argocd-ai-assistant

# Install dependencies (requires --force due to React peer dependency quirks)
yarn install --force

# Production build + package
yarn run package
```

This produces a tar archive at:

```
dist/extension-argocd-ai-assistant.tar
```

The tar name carries no version, because a release puts the version in the URL path instead. The `VERSION` environment variable still stamps the bundle filename inside the tar, and falls back to the `package.json` version when it is unset.

---

## Host the Extension

The Argo CD Extension Installer downloads the extension tar from a URL during pod initialisation. Use the GitHub Release asset URL:

```
https://github.com/saidsef/argocd-ai-assistant/releases/download/v<version>/extension-argocd-ai-assistant.tar
```

Replace `<version>` with a tag from the [Releases page](https://github.com/saidsef/argocd-ai-assistant/releases). This is the recommended form, because a pinned URL is the only one a checksum can be set against.

To track the newest release instead, drop the version and use the `latest` alias:

```
https://github.com/saidsef/argocd-ai-assistant/releases/latest/download/extension-argocd-ai-assistant.tar
```

The artefact behind that URL changes with every release, so `EXTENSION_CHECKSUM` cannot be pinned against it and an `argocd-server` restart can pick up a build you have not reviewed.

The 50 newest releases are kept and older ones are deleted nightly, which is about eight weeks of history. The git tag survives the deletion, so a pruned revision can still be checked out and rebuilt, but its tarball URL stops resolving. Move a pin forward before it ages out, or host the tar yourself.

If you cannot use GitHub Releases, host the tar file on an internal artefact server, S3 bucket, or HTTP server accessible from the cluster.

!!! warning "Pin the artefact integrity"
    The installer runs JavaScript in the Argo CD UI with the user's session, so a tampered tar is an account-compromise risk. Serve `EXTENSION_URL` over HTTPS from a trusted host and set `EXTENSION_CHECKSUM_URL` (or `EXTENSION_CHECKSUM`) on the installer so it verifies the download. See [Security considerations](deployment/proxy.md#security-considerations).

---

## Choose a deployment method

Pick the page that matches how you run Argo CD and read only that one. Each is the whole install for that method, in the order you apply it.

| Method | Use when | Page |
|--------|----------|------|
| **Argo CD Operator** | You manage Argo CD via the `ArgoCD` CR (OpenShift / Kubernetes) | [Install with the Argo CD Operator](deployment/operator.md) |
| **Helm chart** | You install Argo CD with the community `argo/argo-cd` chart | [Install with the Helm chart](deployment/helm.md) |
| **Raw manifests** | You apply Argo CD's install manifests directly | [Install with raw manifests](deployment/raw.md) |

The Helm path is also a file you can pass straight to `helm -f`: [`examples/argo-cd-values.yaml`](https://github.com/saidsef/argocd-ai-assistant/blob/main/examples/argo-cd-values.yaml).

### What every install has to achieve

The five steps are the same on all three pages, only the place each value goes changes. Whichever page you follow, the same six things end up true:

- the proxy extension is enabled on `argocd-server`
- the proxy knows where your LLM is
- users are allowed to invoke it
- the installer initContainer downloads and extracts the extension
- the `argocd-server` container mounts the volume it extracted into
- the model is either named in the settings extension or discoverable from the backend

!!! warning "The `argocd-server` container must mount the `extensions` volume"
    The initContainer extracts the bundle into an `emptyDir`, but `argocd-server` can only serve it if the **same volume is mounted into the server container too** - not just the initContainer. The Helm chart's built-in `server.extensions` block does this for you, with the Operator and raw manifests you add the server-side `volumeMounts` entry yourself. It is the most common reason the Assistant tab never appears.

> Every snippet in these guides has a tested, runnable counterpart under
> [`examples/kind/`](https://github.com/saidsef/argocd-ai-assistant/tree/main/examples/kind),
> verified end to end against Argo CD v3.3+/v3.4 (see [Local Testing with kind](deployment/local-testing.md)).

---

## Next: configure and verify

Once Argo CD is installed with the extension:

1. Tell the Assistant which model/endpoint to use - [Settings Extension](deployment/settings.md)
2. Point the proxy at your LLM backend and enable it - [Proxy & Backend Configuration](deployment/proxy.md)
3. Confirm it works - [Verification & Troubleshooting](deployment/verification.md), or run the [kind harness](deployment/local-testing.md)
