# Local end-to-end testing with kind

This directory spins up a local [kind](https://kind.sigs.k8s.io/) cluster, installs
Argo CD using each of the documented deployment methods, installs the **Argo CD AI
Assistant** extension built from the local source, wires it to an in-cluster **mock
OpenAI-compatible LLM**, and verifies the whole path end to end — including a real
request through the Argo CD proxy extension that streams a completion back.

It exists so you can prove a change actually deploys and works before cutting a
release, without needing a GPU, a real LLM, or any external hosting.

## What gets verified

`verify.sh` runs eight checks against a live `argocd-server`:

1. the installer initContainer downloaded and extracted the extension tar
2. the extension bundle is present at `/tmp/extensions/resources/extensions-argocd-ai-assistant/`
3. the settings extension is present at `/tmp/extensions/resources/argocd-ai-assistant-settings/`
4. `argocd-server` serves `/extensions.js` containing the bundle **and** the settings
5. a sample `Application` exists (required for the proxy's RBAC check)
6. `POST /extensions/assistant/v1/chat/completions` returns a streamed completion
   from the backend, proving the proxy extension + RBAC + service routing all work
7. the API token Secret exists - `verify.sh` reads the dedicated, labeled Secret
   `argocd-ai-assistant-secret` back and confirms `openai-api-key` decodes to the
   expected value (a direct read from the cluster, not inferred from behaviour)
8. the proxy injected the token via `$argocd-ai-assistant-secret:openai-api-key`
   as the `Authorization` header - the mock LLM echoes what it received, proving
   the documented [token-injection path](../../docs/deployment/proxy.md) works

## Prerequisites

- `kind`, `kubectl`, `helm`, `docker` (running), `yarn` + `node`, `python3`, `curl`
- Internet access (pulls Argo CD manifests, the chart, the installer image, and
  the `nginx`/`python` images used by the support services)

## Usage

```bash
# from the repo root
./examples/kind/setup.sh raw        # raw Kubernetes manifests
./examples/kind/setup.sh helm       # community Helm chart (argo/argo-cd)
./examples/kind/setup.sh operator   # argocd-operator + ArgoCD CR
```

Each run is fully isolated in its own cluster (`argocd-ai-<method>`). Successful
output ends with `== 8 passed, 0 failed ==`.

Useful overrides:

```bash
CLUSTER=my-cluster NS=argocd ARGOCD_VERSION=v3.4.4 ./examples/kind/setup.sh raw
KEEP=1 ./examples/kind/setup.sh helm     # (reserved) keep cluster after run
```

## Open the UI manually

```bash
CTX=kind-argocd-ai-raw   # or -helm / -operator
kubectl --context $CTX -n argocd port-forward deploy/argocd-server 8080:8080
# browse https://localhost:8080  (accept the self-signed cert)
# user: admin
kubectl --context $CTX -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' | base64 -d ; echo
# (operator method: secret is argocd-cluster, key admin.password)
```

Open any Application, click a resource, and use the **Assistant** tab.

## Swap the mock LLM for a real backend

The mock (`mock-llm/mock-llm.yaml`) just streams a canned OpenAI-style response so
the path is deterministic. To use a real backend, point `extension.config.assistant`
at it instead of `http://mock-llm:8000`:

- in-cluster Ollama: `http://ollama.ollama.svc.cluster.local:11434`
- in-cluster vLLM: `http://vllm.vllm.svc.cluster.local:8000`
- external OpenAI/DeepSeek: route through the proxy with an injected `Authorization`
  header (see [`docs/deployment.md`](../../docs/deployment.md#proxy-extension-configuration))

## Tear down

```bash
kind delete cluster --name argocd-ai-raw
kind delete cluster --name argocd-ai-helm
kind delete cluster --name argocd-ai-operator
```

## File map

| Path | Purpose |
|------|---------|
| `setup.sh` | create cluster, build + host tar, deploy mock LLM, install Argo CD via a method, verify |
| `verify.sh` | the six end-to-end checks (method-agnostic) |
| `kind-config.yaml` | optional single-node kind config (host port mappings) |
| `ext-host/ext-host.yaml` | nginx serving the locally built tar in-cluster |
| `mock-llm/mock-llm.yaml` | deterministic OpenAI-compatible mock (SSE streaming) |
| `settings-configmap.yaml` | the settings extension (Option B, ConfigMap mount) |
| `llm-api-secret.yaml` | dedicated labeled Secret the proxy reads (`$argocd-ai-assistant-secret:openai-api-key`) |
| `sample-app.yaml` | minimal Application used by the proxy RBAC check |
| `raw/` | argocd-cm / argocd-cmd-params-cm / argocd-rbac-cm / argocd-server patches |
| `helm/values.yaml` | Helm values (built-in `server.extensions` block) |
| `operator/argocd-cr.yaml` | ArgoCD custom resource for the argocd-operator |

> The deployment artifacts here are the same ones referenced from
> [`docs/deployment.md`](../../docs/deployment.md); they have each been verified to
> pass all eight checks on Argo CD v3.3+/v3.4.
