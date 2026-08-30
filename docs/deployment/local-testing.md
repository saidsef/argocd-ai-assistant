# Local Testing with kind

Before rolling the extension out to a real cluster, you can prove it deploys and works on a throwaway [kind](https://kind.sigs.k8s.io/) cluster. The [`examples/kind/`](https://github.com/saidsef/argocd-ai-assistant/tree/main/examples/kind) harness:

- builds the extension from the local source and hosts the tar in-cluster (no GitHub Release or external hosting needed),
- stands up a deterministic, OpenAI-compatible **mock LLM** so no GPU or API key is required,
- installs Argo CD using the method you choose, and
- runs nine checks - including a real streamed request through the proxy extension, a direct read-back of the API token from its dedicated labelled Secret, proof that the proxy injects it, and the model lookup the Assistant falls back on.

```shell
# from the repo root - pick one method per run
./examples/kind/setup.sh raw        # raw Kubernetes manifests
./examples/kind/setup.sh helm       # community Helm chart
./examples/kind/setup.sh operator   # argocd-operator + ArgoCD CR

# tear down
kind delete cluster --name argocd-ai-raw   # or -helm / -operator
```

A successful run ends with `== 9 passed, 0 failed ==`. Each method runs in its own isolated cluster. The per-method manifests, Helm values and CR used by the harness double as worked, tested examples for the snippets on the [install page](install.md). See [`examples/kind/README.md`](https://github.com/saidsef/argocd-ai-assistant/blob/main/examples/kind/README.md) for details and how to swap the mock LLM for a real backend.
