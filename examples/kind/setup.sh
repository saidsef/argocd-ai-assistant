#!/usr/bin/env bash
# Spin up a kind cluster, install Argo CD (raw|helm|operator) + the AI Assistant
# extension built from local source, wire an in-cluster mock LLM, and verify.
# Usage: ./setup.sh [raw|helm|operator]   (env: CLUSTER, NS, ARGOCD_VERSION, PORT)
set -euo pipefail

METHOD="${1:-raw}"
NS="${NS:-argocd}"
CLUSTER="${CLUSTER:-argocd-ai-$METHOD}"
ARGOCD_VERSION="${ARGOCD_VERSION:-stable}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TAR="$ROOT/dist/extension-argocd-ai-assistant-kind-test.tar"
CTX="kind-$CLUSTER"
K="kubectl --context $CTX"

echo "== [1/5] Build the extension from source =="
( cd "$ROOT" && yarn install --force && VERSION=kind-test yarn run package )
test -f "$TAR" || { echo "build did not produce $TAR"; exit 1; }

echo "== [2/5] Create kind cluster '$CLUSTER' =="
kind get clusters | grep -qx "$CLUSTER" || kind create cluster --name "$CLUSTER" --wait 120s

echo "== [3/5] Namespace + support services (tar host + mock LLM) =="
$K create namespace "$NS" --dry-run=client -o yaml | $K apply -f -
$K -n "$NS" delete configmap ext-tar --ignore-not-found
$K -n "$NS" create configmap ext-tar --from-file=extension.tar="$TAR"
$K -n "$NS" apply -f "$HERE/ext-host.yaml" -f "$HERE/mock-llm.yaml"
# Labeled Secret the proxy reads via $argocd-ai-assistant-secret:openai-api-key.
$K -n "$NS" apply -f "$HERE/llm-api-secret.yaml"
$K -n "$NS" rollout status deploy/ext-host --timeout=120s
$K -n "$NS" rollout status deploy/mock-llm --timeout=120s

echo "== [4/5] Install Argo CD via '$METHOD' + AI Assistant =="
case "$METHOD" in
  raw)
    $K -n "$NS" apply --server-side --force-conflicts \
      -f "https://raw.githubusercontent.com/argoproj/argo-cd/$ARGOCD_VERSION/manifests/install.yaml"
    $K -n "$NS" apply -f "$HERE/settings-configmap.yaml"
    $K -n "$NS" patch cm argocd-cm         --type merge     --patch-file "$HERE/raw-cm-patch.yaml"
    $K -n "$NS" patch cm argocd-cmd-params-cm --type merge -p '{"data":{"server.enable.proxy.extension":"true"}}'
    $K -n "$NS" patch cm argocd-rbac-cm        --type merge -p '{"data":{"policy.default":"role:readonly","policy.csv":"p, role:readonly, extensions, invoke, assistant, allow"}}'
    $K -n "$NS" patch deploy argocd-server --type strategic --patch-file "$HERE/raw-server-patch.yaml"
    $K -n "$NS" rollout restart deploy argocd-server
    ;;
  helm)
    helm repo add argo https://argoproj.github.io/argo-helm >/dev/null 2>&1 || true
    helm repo update argo >/dev/null
    $K -n "$NS" apply -f "$HERE/settings-configmap.yaml"
    helm --kube-context "$CTX" upgrade --install argocd argo/argo-cd \
      -n "$NS" -f "$HERE/helm-values.yaml" --wait --timeout 5m
    ;;
  operator)
    OPERATOR_VERSION="${OPERATOR_VERSION:-v0.18.0}"
    # cert-manager backs the operator's admission webhook.
    $K apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml
    $K -n cert-manager rollout status deploy/cert-manager-webhook --timeout=180s
    $K -n cert-manager rollout status deploy/cert-manager-cainjector --timeout=120s
    # Server-side apply: the bundled CRDs exceed the client-side apply annotation limit.
    kubectl --context "$CTX" kustomize \
      "https://github.com/argoproj-labs/argocd-operator/config/default?ref=$OPERATOR_VERSION" \
      | $K apply --server-side --force-conflicts -f -
    $K -n argocd-operator-system rollout status deploy/argocd-operator-controller-manager --timeout=240s
    $K -n "$NS" apply -f "$HERE/settings-configmap.yaml"
    $K -n "$NS" apply -f "$HERE/operator-cr.yaml"
    # The operator creates argocd-server asynchronously; wait before rollout-status.
    echo "Waiting for the operator to create argocd-server..."
    for _ in $(seq 1 60); do $K -n "$NS" get deploy argocd-server >/dev/null 2>&1 && break; sleep 3; done
    ;;
  *)
    echo "unknown method '$METHOD' (use raw|helm|operator)"; exit 2;;
esac

echo "Waiting for argocd-server to roll out..."
$K -n "$NS" rollout status deploy/argocd-server --timeout=300s

echo "== [5/5] Verify =="
PORT="${PORT:-18080}" "$HERE/verify.sh" "$NS" "$CTX"

echo ""
echo "Done. UI:  kubectl --context $CTX -n $NS port-forward deploy/argocd-server 8080:8080"
echo "Tear down: kind delete cluster --name $CLUSTER"
