# Verification and troubleshooting

Run these checks after `argocd-server` restarts. The commands use the container names from the Operator and raw manifest pages. The Helm chart names the server container `server` and the installer `argocd-ai-assistant`.

## Checks

1. The installer extracted the extension, and its log contains `installed successfully`:

    ```shell
    kubectl -n argocd logs deploy/argocd-server -c extension-argocd-ai-assistant
    ```

2. The server container can see the extension:

    ```shell
    kubectl -n argocd exec deploy/argocd-server -c argocd-server -- \
      ls /tmp/extensions/resources/extensions-argocd-ai-assistant/
    ```

3. Argo CD serves the extension. It joins every extension under `/tmp/extensions/resources/` into one `/extensions.js`:

    ```shell
    kubectl -n argocd port-forward deploy/argocd-server 8080:8080 &
    curl -sk https://localhost:8080/extensions.js | grep -c extension-argocd-ai-assistant-bundle
    curl -sk https://localhost:8080/extensions.js | grep -c 'argocdAssistantSettings *='
    ```

    A count above zero from the first command means the extension loaded. From the second, it means a settings file loaded.

4. The proxy answers. This needs an admin session and an existing Application:

    ```shell
    PASSWORD=$(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d)
    TOKEN=$(curl -sk https://localhost:8080/api/v1/session \
      -H 'Content-Type: application/json' \
      -d "{\"username\":\"admin\",\"password\":\"$PASSWORD\"}" \
      | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
    curl -sk -N https://localhost:8080/extensions/assistant/v1/chat/completions \
      --cookie "argocd.token=$TOKEN" \
      -H 'Content-Type: application/json' \
      -H "Argocd-Application-Name: argocd:<app>" \
      -H "Argocd-Project-Name: <project>" \
      -d '{"model":"<model>","messages":[{"role":"user","content":"hi"}],"stream":true}'
    ```

    The reply streams `chat.completion.chunk` lines and ends with `data: [DONE]`. With the Operator, the admin password is in the `argocd-cluster` Secret under `admin.password`.

5. In the UI, open an Application, select a resource, open the **Assistant** tab and ask a question.

The [kind harness](local-testing.md) runs these checks and more against a throwaway cluster.

## Troubleshooting

### Missing Assistant tab

- Check that the installer's log contains `installed successfully`.
- Check that the `argocd-server` container mounts the extensions volume, not only the initContainer. This is the most common cause.
- Check that `/extensions.js` contains `extension-argocd-ai-assistant-bundle`.

### "LLM endpoint not found (404)"

The proxy is registered under a name other than `assistant`, as [Extension name](proxy.md#extension-name) describes. List the proxy keys in `argocd-cm`:

```shell
kubectl -n argocd get cm argocd-cm -o jsonpath='{.data}' | grep -o 'extension\.config\.[a-z0-9-]*'
```

When `data.baseURL` is set, the 404 can also come from that URL.

### "Still resolving an Argo CD application to authorise this request"

The extension has not yet found an Application to send with the request, or the user cannot read any. On the system-level `/assistant` page, the user needs read access to at least one Application.

### "Authentication failed (401)" or "Access forbidden (403)"

The backend rejected the API key. Check that the Secret holds `Bearer <your-api-token>`, as [API token injection](proxy.md#api-token-injection) describes. If the key is correct, check that the user's role can invoke the `assistant` extension, as [RBAC](proxy.md#rbac) describes.

### Model choice message

With `model` unset, the Assistant asks the backend for `/v1/models`. When the backend serves several models, the message lists them, and one of them goes in the `model` [setting](settings.md). When the lookup returns nothing, check that the backend is reachable from `argocd-server` and serves `/v1/models`. The browser console shows the status it returned.

### Empty reply

The message names the cause from the stream's `finish_reason`:

| Cause | Fix |
|---|---|
| A content filter | Rephrase the question, or check the backend's content filter |
| The output token limit | Attach less context, or raise the backend's limit |
| No usable data | Check that the backend streams OpenAI-compatible server-sent events from `/v1/chat/completions` |

### "The assistant stopped responding"

The backend stayed silent for longer than the extension's fixed limit, which a setting cannot change. A backend that loads its model on the first request may need to keep the model loaded. [Connection timeouts](proxy.md#connection-timeouts) covers the proxy's own settings.

### CORS errors in the browser console

The browser is calling a backend directly. Leave `data.baseURL` unset to send requests through the proxy, or allow the Argo CD origin on the backend. MCP servers need the headers listed in [MCP servers](settings.md#mcp-servers).
