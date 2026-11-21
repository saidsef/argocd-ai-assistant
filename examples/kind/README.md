# Local end-to-end testing with kind

`setup.sh` creates a [kind](https://kind.sigs.k8s.io/) cluster, installs Argo CD with
one of the three documented methods, installs the extension built from this working
tree and runs `verify.sh` against it. A mock LLM in the cluster answers every request.
The run does not need a GPU, an API key or a release.

## Prerequisites

`kind`, `kubectl`, `helm`, a running `docker`, `node` with `yarn`, `python3` and `curl`.
The run downloads Argo CD's manifests, the Helm chart, the operator and container
images, and needs internet access.

## Usage

```bash
./examples/kind/setup.sh raw        # raw manifests
./examples/kind/setup.sh helm       # argo/argo-cd Helm chart
./examples/kind/setup.sh operator   # argocd-operator and an ArgoCD resource
```

Each method runs in its own cluster, `argocd-ai-<method>`. A successful run ends with
`== 9 passed, 0 failed ==`.

| Variable | Default | Effect |
|---|---|---|
| `CLUSTER` | `argocd-ai-<method>` | kind cluster name |
| `NS` | `argocd` | Argo CD namespace |
| `ARGOCD_VERSION` | `stable` | Argo CD branch or tag for the raw method's manifests |
| `OPERATOR_VERSION` | `v0.18.0` | argocd-operator release for the operator method |
| `PORT` | `18080` | local port that `verify.sh` forwards to `argocd-server` |

`verify.sh [namespace] [kube-context]` runs the checks on their own against any
cluster.

## Checks

`verify.sh` checks that:

1. the installer initContainer logged `installed successfully`
2. the bundle is in `/tmp/extensions/resources/extensions-argocd-ai-assistant/`
3. the settings file is in `/tmp/extensions/resources/argocd-ai-assistant-settings/`
4. `/extensions.js` contains the bundle and the settings
5. a sample Application exists, which the proxy needs to authorise requests
6. `POST /extensions/assistant/v1/chat/completions` streams a completion through the
   proxy
7. the Secret `argocd-ai-assistant-secret` holds the expected `openai-api-key`
8. the proxy sent that value as the `Authorization` header, which the mock echoes
9. `GET /extensions/assistant/v1/models` lists exactly one model

## Opening the UI

```bash
CTX=kind-argocd-ai-raw   # or -helm, -operator
kubectl --context $CTX -n argocd port-forward deploy/argocd-server 8080:8080
kubectl --context $CTX -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' | base64 -d; echo
```

Browse to https://localhost:8080 and sign in as `admin`. The operator method keeps the
password in the `argocd-cluster` Secret under `admin.password`.

## A real backend

The mock streams the same reply to every request. To use a real backend, point
`extension.config.assistant` at it instead of `http://mock-llm:8000`, for example
`http://ollama.ollama.svc.cluster.local:11434`. An external provider needs its API key
injected by the proxy, as
[API token injection](../../docs/deployment/proxy.md#api-token-injection) describes.

## Tearing down

```bash
kind delete cluster --name argocd-ai-raw   # or -helm, -operator
```

## Files

| Path | Purpose |
|---|---|
| `setup.sh` | Creates the cluster, builds and serves the tar, deploys the mock, installs Argo CD and runs `verify.sh` |
| `verify.sh` | The nine checks, for any install method |
| `ext-host.yaml` | nginx serving the locally built tar inside the cluster |
| `mock-llm.yaml` | OpenAI-compatible mock that streams a fixed reply and echoes the `Authorization` header |
| `settings-configmap.yaml` | The settings extension without a model, which makes the Assistant ask the backend for one |
| `llm-api-secret.yaml` | The labelled Secret the proxy reads the API key from |
| `sample-app.yaml` | A minimal Application for the proxy's authorisation check |
| `raw-cm-patch.yaml`, `raw-server-patch.yaml` | The `argocd-cm` and `argocd-server` patches for the raw method |
| `helm-values.yaml` | Values for the Helm method |
| `operator-cr.yaml` | The ArgoCD resource for the operator method |
