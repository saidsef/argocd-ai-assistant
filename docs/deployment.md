# Deployment Guide

This guide covers how to build, package, host, and install the Argo CD AI Assistant extension into an Argo CD instance.

It is split into a per-method install page (pick the one that matches how you run Argo CD) plus shared reference pages for the backend, settings, local testing, and verification:

- **Install:** [Argo CD Operator](deployment/operator.md) · [Helm Chart](deployment/helm.md) · [Raw Manifests](deployment/raw.md)
- **Configure:** [Settings Extension](deployment/settings.md) · [Proxy & Backend](deployment/proxy.md)
- **Test:** [Local Testing with kind](deployment/local-testing.md) · [Verification & Troubleshooting](deployment/verification.md)

---

## How It Works

Argo CD supports UI extensions via the [Extension Installer](https://argo-cd.readthedocs.io/en/stable/developer-guide/extensions/proxy-extensions/) mechanism. The extension is delivered as a compressed tar archive containing JavaScript bundles. On startup, Argo CD's `argocd-server` pod runs an initContainer that downloads the extension archive and extracts it into `/tmp/extensions/`. The extension then registers itself with the Argo CD UI via the global `extensionsAPI`.

The AI Assistant extension communicates with your LLM backend through the Argo CD **Proxy Extension**. This avoids CORS issues by routing all backend traffic through the Argo CD server.

```
User Browser -> Argo CD UI -> Extension JS
                                    |
                                    v
                           Argo CD Proxy Extension
                                    |
                                    v
                              LLM Backend (Local Inference Server/vLLM/OpenAI)
```

---

## Prerequisites

- Argo CD >= v2.13
- Argo CD server deployed with the `--enable-proxy-extension` flag (see [Proxy & Backend](deployment/proxy.md#enabling-the-proxy-extension))
- A running LLM backend with an OpenAI-compatible API
- (Optional) `oc` or `kubectl` CLI access to the cluster

---

## Build and Package

### Automated Release (Recommended)

The repository includes a GitHub Actions workflow that handles versioning, building, packaging, tagging, and releasing automatically.

When a change is merged to `main` and the CI workflow passes, the release workflow:

1. Analyzes the diff since the last tag and classifies the change as **major**, **minor**, or **patch**
2. Increments the version accordingly and creates an annotated Git tag
3. Builds and packages the extension
4. Publishes a GitHub Release with the extension tar as an asset and auto-generated release notes

No manual version bumping is required. Find the latest release tag on the [GitHub Releases page](https://github.com/saidsef/argocd-ai-assistant/releases) and use it in place of the `<version>` placeholder in the examples. The latest release is [v2.10.0](https://github.com/saidsef/argocd-ai-assistant/releases/tag/v2.10.0).

### Manual Build

If you are building from source locally:

```shell
# Clone the repository
git clone https://github.com/saidsef/argocd-ai-assistant.git
cd argocd-ai-assistant

# Install dependencies (requires --force due to React peer dependency quirks)
yarn install --force

# Production build + package with a specific version
VERSION=2.10.0 yarn run package
```

This produces a tar archive at:

```
dist/extension-argocd-ai-assistant-<version>.tar
```

The `VERSION` environment variable overrides the placeholder version in `package.json`. If omitted, the build falls back to `package.json` version.

---

## Host the Extension

The Argo CD Extension Installer downloads the extension tar from a URL during pod initialization. Use the GitHub Release asset URL:

```
https://github.com/saidsef/argocd-ai-assistant/releases/download/v<version>/extension-argocd-ai-assistant-v<version>.tar
```

Replace `<version>` with the latest release tag (e.g., `v2.10.0`).

If you cannot use GitHub Releases, host the tar file on an internal artifact server, S3 bucket, or HTTP server accessible from the cluster.

!!! warning "Pin the artifact integrity"
    The installer runs JavaScript in the Argo CD UI with the user's session, so a tampered tar is an account-compromise risk. Serve `EXTENSION_URL` over HTTPS from a trusted host and set `EXTENSION_CHECKSUM_URL` (or `EXTENSION_CHECKSUM`) on the installer so it verifies the download. See [Security considerations](deployment/proxy.md#security-considerations).

---

## Choose a deployment method

Pick the page that matches how you run Argo CD. Each is a complete, self-contained walkthrough that enables the proxy extension, runs the installer initContainer, grants RBAC, and wires in the settings extension.

| Method | Use when | Guide |
|--------|----------|-------|
| **Argo CD Operator** | You manage Argo CD via the `ArgoCD` CR (OpenShift / Kubernetes) | [Operator](deployment/operator.md) |
| **Helm chart** | You install Argo CD with the community `argo/argo-cd` chart | [Helm](deployment/helm.md) |
| **Raw manifests** | You apply Argo CD's install manifests directly | [Raw Manifests](deployment/raw.md) |

!!! warning "The `argocd-server` container must mount the `extensions` volume"
    The initContainer extracts the bundle into an `emptyDir`, but `argocd-server` can only serve it if the **same volume is mounted into the server container too** - not just the initContainer. The Helm chart's built-in `server.extensions` block does this for you; with the Operator and raw manifests you must add the server-side `volumeMounts` entry shown on those pages.

> Every snippet in these guides has a tested, runnable counterpart under
> [`examples/kind/`](https://github.com/saidsef/argocd-ai-assistant/tree/main/examples/kind),
> verified end to end against Argo CD v3.3+/v3.4 (see [Local Testing with kind](deployment/local-testing.md)).

---

## Next: configure and verify

Once Argo CD is installed with the extension:

1. Tell the Assistant which model/endpoint to use - [Settings Extension](deployment/settings.md)
2. Point the proxy at your LLM backend and enable it - [Proxy & Backend Configuration](deployment/proxy.md)
3. Confirm it works - [Verification & Troubleshooting](deployment/verification.md), or run the [kind harness](deployment/local-testing.md)
