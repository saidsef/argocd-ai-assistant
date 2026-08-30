# Verification & Troubleshooting

After applying the configuration, wait for the Argo CD server pod to restart (the Operator or Deployment rollout handles this).

## Verification

1. **Check the initContainer logs** (look for `UI extension installed successfully`):

```shell
kubectl logs -n argocd deployment/argocd-server -c extension-argocd-ai-assistant
```

2. **Verify the extension files are present** in the running `argocd-server` container:

```shell
kubectl exec -n argocd deployment/argocd-server -c argocd-server -- ls -la /tmp/extensions/resources/extensions-argocd-ai-assistant/
```

3. **Confirm the server is serving the bundle.** Argo CD concatenates every extension `.js` under `/tmp/extensions/resources/` into a single `/extensions.js` (there is no per-file URL). Port-forward and check it contains the bundle:

```shell
kubectl -n argocd port-forward deployment/argocd-server 8080:8080 &
curl -sk https://localhost:8080/extensions.js | grep -c argocdAssistantSettings   # > 0 means the settings + bundle loaded
```

4. **Test the proxy path end to end** without a browser. The proxy authenticates with the `argocd.token` cookie and requires the application/project headers, so an Application must exist:

```shell
TOKEN=$(curl -sk https://localhost:8080/api/v1/session \
  -d "{\"username\":\"admin\",\"password\":\"$(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d)\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

curl -sk -N https://localhost:8080/extensions/assistant/v1/chat/completions \
  --cookie "argocd.token=$TOKEN" \
  -H "Argocd-Application-Name: argocd:<your-app>" \
  -H "Argocd-Project-Name: default" \
  -d '{"model":"<your-model>","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

You should see a streamed `chat.completion.chunk` response from your backend ending in `data: [DONE]`.

5. **In the UI**, open any Application, click a resource, confirm the **Assistant** tab appears, and ask a question - the chatbot should stream a response.

> The [`examples/kind/`](https://github.com/saidsef/argocd-ai-assistant/tree/main/examples/kind) harness automates checks 1-4 against a throwaway cluster - see [Local Testing with kind](local-testing.md).

## Troubleshooting

### The Assistant tab does not appear

- Verify the initContainer ran successfully: `kubectl logs -n argocd deployment/argocd-server -c extension-argocd-ai-assistant`
- Check that the extension JS file exists in the pod: `kubectl exec ... -- ls /tmp/extensions/resources/extensions-argocd-ai-assistant/`
- **If the file exists in the initContainer logs but the tab still does not appear, confirm the `extensions` volume is mounted into the `argocd-server` _container_, not only the initContainer** - this is the most common misconfiguration. Check `/extensions.js` is served: `curl -sk https://<argocd>/extensions.js | grep argocdAssistantSettings`.
- Ensure the `--enable-proxy-extension` flag (or `server.enable.proxy.extension: "true"`) is set on argocd-server.

### The tab appears but every question returns 404

The proxy extension is registered under some other name. The browser always asks for `/extensions/assistant`, so `extension.config.assistant` and the `invoke` policy have to use `assistant` too - see [the note on the proxy page](proxy.md). Read back the key you actually applied:

```shell
kubectl -n argocd get cm argocd-cm -o jsonpath='{.data}' | grep -o 'extension\.config\.[a-z0-9-]*'
```

### "LLM model is not configured"

- Set the `model` field in `globalThis.argocdAssistantSettings` - it is required (see [Settings Extension](settings.md)).
- Verify the settings extension is loaded (`globalThis.argocdAssistantSettings` is defined). Check the browser console for JS errors.
- Ensure the `baseURL` in settings is correct and reachable from the Argo CD server pod.

### Streaming does not work / responses are buffered

- Verify your Argo CD version supports proxy extensions with streaming (requires Argo CD >= v2.13).
- Check the LLM backend streams at all. A model that is slow to its first token can outlast the proxy defaults - see [Tuning the connection](proxy.md#tuning-the-connection).

### CORS errors in the browser console

- This indicates traffic is not going through the proxy extension. Ensure the `baseURL` in settings points to the proxy path (or omit it to use the default proxy behaviour).

### RBAC errors

- Ensure the RBAC policy `p, role:readonly, extensions, invoke, assistant, allow` is configured.
- Verify the user has a role that includes this permission.
