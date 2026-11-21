# Local testing with kind

The harness in [`examples/kind/`](https://github.com/saidsef/argocd-ai-assistant/tree/main/examples/kind) installs Argo CD and the extension on a throwaway [kind](https://kind.sigs.k8s.io/) cluster and checks the whole path. It builds the extension from your working tree, serves the tar inside the cluster and answers questions with a mock LLM. It does not need a release, a GPU or an API key.

```shell
./examples/kind/setup.sh raw        # raw manifests
./examples/kind/setup.sh helm       # Helm chart
./examples/kind/setup.sh operator   # argocd-operator
```

Each method runs in its own cluster, `argocd-ai-<method>`. A successful run ends with `== 9 passed, 0 failed ==`. Delete the cluster afterwards with `kind delete cluster --name argocd-ai-<method>`.

The harness uses the install pages' manifests, pointed at a mock LLM. [`examples/kind/README.md`](https://github.com/saidsef/argocd-ai-assistant/blob/main/examples/kind/README.md) lists its prerequisites, checks, variables and files.
