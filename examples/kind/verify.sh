#!/usr/bin/env bash
# Verify the AI Assistant extension is installed and working: install, serving,
# proxy round-trip, and API-token injection from argocd-secret.
# Usage: verify.sh [namespace] [kube-context]   (env: PORT)
#
# No `pipefail`: several checks pipe a long producer into `grep -q`, whose early
# exit SIGPIPEs the producer - under pipefail that would mask a successful grep.
set -u

NS="${1:-argocd}"
CTX="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
BUNDLE="extension-argocd-ai-assistant-bundle-kind-test.min.js"
PORT="${PORT:-18080}"
K="kubectl"
[ -n "$CTX" ] && K="kubectl --context $CTX"

# Container/initContainer names differ by method (Helm renames the server to
# `server`; the installer initContainer is `argocd-ai-assistant`), so detect them.
MAIN="$($K -n "$NS" get deploy argocd-server \
        -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\n"}{end}' 2>/dev/null \
        | grep -E 'server' | head -1)"
MAIN="${MAIN:-argocd-server}"
INIT="$($K -n "$NS" get deploy argocd-server \
        -o jsonpath='{range .spec.template.spec.initContainers[*]}{.name}{"\n"}{end}' 2>/dev/null \
        | grep -i assistant | head -1)"
INIT="${INIT:-extension-argocd-ai-assistant}"

pass=0; fail=0
ok()  { echo "  [PASS] $1"; pass=$((pass+1)); }
bad() { echo "  [FAIL] $1"; fail=$((fail+1)); }

echo "== Verifying Argo CD AI Assistant in namespace '$NS' (context '${CTX:-current}') =="

# 1. initContainer extracted the extension
if $K -n "$NS" logs deploy/argocd-server -c "$INIT" 2>/dev/null | grep -q "installed successfully"; then
  ok "initContainer extracted the extension"
else
  bad "initContainer did not report success"
fi

# 2. bundle present in pod
if $K -n "$NS" exec deploy/argocd-server -c "$MAIN" -- \
     test -f "/tmp/extensions/resources/extensions-argocd-ai-assistant/$BUNDLE" 2>/dev/null; then
  ok "extension bundle present in pod"
else
  bad "extension bundle missing in pod"
fi

# 3. settings present in pod
if $K -n "$NS" exec deploy/argocd-server -c "$MAIN" -- \
     test -f /tmp/extensions/resources/argocd-ai-assistant-settings/extension-settings.js 2>/dev/null; then
  ok "settings extension present in pod"
else
  bad "settings extension missing in pod"
fi

# port-forward for the HTTP checks
$K -n "$NS" port-forward deploy/argocd-server "$PORT:8080" >"/tmp/pf-verify-$NS.log" 2>&1 &
PF=$!
trap 'kill $PF 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do curl -sk "https://localhost:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.5; done

# 4. /extensions.js served with bundle + settings
EXTJS="/tmp/extjs-$NS.out"
curl -sk "https://localhost:$PORT/extensions.js" -o "$EXTJS"
if grep -q "argocdAssistantSettings" "$EXTJS" && grep -q "$BUNDLE" "$EXTJS"; then
  ok "/extensions.js served with bundle + settings"
else
  bad "/extensions.js is missing the bundle or settings"
fi

# 5. sample Application exists (the proxy resolves it for RBAC)
$K -n "$NS" apply -f "$HERE/sample-app.yaml" >/dev/null 2>&1
if $K -n "$NS" get application sample-app >/dev/null 2>&1; then
  ok "sample Application present"
else
  bad "sample Application missing"
fi

# 6. proxy round-trip (admin password: argocd-initial-admin-secret for raw/helm,
#    argocd-cluster/admin.password for the operator)
PW="$($K -n "$NS" get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' 2>/dev/null | base64 -d)"
if [ -z "$PW" ]; then
  PW="$($K -n "$NS" get secret argocd-cluster -o jsonpath='{.data.admin\.password}' 2>/dev/null | base64 -d)"
fi
TOKEN="$(curl -sk "https://localhost:$PORT/api/v1/session" -H 'Content-Type: application/json' \
          -d "{\"username\":\"admin\",\"password\":\"$PW\"}" \
          | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))' 2>/dev/null)"
RESPF="/tmp/proxy-resp-$NS.out"
curl -sk -N "https://localhost:$PORT/extensions/assistant/v1/chat/completions" \
  --cookie "argocd.token=$TOKEN" \
  -H "Argocd-Application-Name: $NS:sample-app" \
  -H "Argocd-Project-Name: default" \
  -H "Content-Type: application/json" \
  -d '{"model":"mock-model","messages":[{"role":"user","content":"hello"}],"stream":true}' \
  -o "$RESPF" 2>/dev/null
if grep -q "chat.completion.chunk" "$RESPF" && grep -q '\[DONE\]' "$RESPF"; then
  ok "proxy round-trip streamed a completion through /extensions/assistant"
else
  bad "proxy round-trip failed: $(head -c 160 "$RESPF")"
fi

# 7. the token Secret exists - read it back (not inferred) from the dedicated,
#    labeled Secret the proxy references
EXPECT_AUTH="Bearer kind-ci-injected-token"
GOT_SECRET="$($K -n "$NS" get secret argocd-ai-assistant-secret -o jsonpath='{.data.openai-api-key}' 2>/dev/null | base64 -d 2>/dev/null)"
if [ "$GOT_SECRET" = "$EXPECT_AUTH" ]; then
  ok "argocd-ai-assistant-secret has openai-api-key (read back: $GOT_SECRET)"
else
  bad "argocd-ai-assistant-secret openai-api-key missing/wrong (read back: '${GOT_SECRET:-<empty>}', want: '$EXPECT_AUTH')"
fi

# 8. the proxy injected the token as the Authorization header (the mock echoes
#    what it received; the caller never sent it)
if grep -q "received-authorization: $EXPECT_AUTH" "$RESPF"; then
  ok "proxy injected the token (\$argocd-ai-assistant-secret:openai-api-key)"
else
  bad "API token not injected (mock saw: $(grep -o 'received-authorization: [^]]*' "$RESPF" | head -1))"
fi

echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
