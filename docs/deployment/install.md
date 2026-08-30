# Install

Three ways to run Argo CD, one set of steps. Pick the tab that matches yours and read only that one - the choice carries down the page, so selecting **Helm** here selects it in every step below.

Whichever you pick, the same six things end up true:

- the proxy extension is enabled on `argocd-server`
- the proxy knows where your LLM is
- users are allowed to invoke it
- the installer initContainer downloads and extracts the extension
- the `argocd-server` container mounts the volume it extracted into
- the settings extension supplies the model name

Replace `v2.10.0` with the [latest release tag](../deployment.md#build-and-package) and `services[].url` with your own backend. [Proxy & Backend Configuration](proxy.md) covers the other backend shapes and the timeouts you can set.

!!! tip "Helm: one file rather than five blocks"
    Every Helm tab below is a fragment of the same values file, already assembled at [`examples/argo-cd-values.yaml`](https://github.com/saidsef/argocd-ai-assistant/blob/main/examples/argo-cd-values.yaml). Edit the release tag and the backend URL, then pass it:

    ```shell
    helm upgrade --install argocd argo/argo-cd \
      --namespace argocd --create-namespace \
      -f examples/argo-cd-values.yaml
    ```

## 1. Enable the proxy extension

=== "Operator"

    ```yaml
    spec:
      server:
        extraCommandArgs:
          - "--enable-proxy-extension"
    ```

=== "Helm"

    ```yaml
    configs:
      params:
        server.enable.proxy.extension: "true"
    ```

=== "Raw manifests"

    ```yaml
    apiVersion: v1
    kind: ConfigMap
    metadata:
      name: argocd-cmd-params-cm
      namespace: argocd
    data:
      server.enable.proxy.extension: "true"
    ```

## 2. Point the proxy at your backend

=== "Operator"

    ```yaml
    spec:
      extraConfig:
        extension.config.assistant: |
          services:
          - url: http://local.local.svc.cluster.local:11434
    ```

=== "Helm"

    ```yaml
    configs:
      cm:
        extension.config.assistant: |
          services:
          - url: http://local.local.svc.cluster.local:11434
    ```

=== "Raw manifests"

    ```yaml
    apiVersion: v1
    kind: ConfigMap
    metadata:
      name: argocd-cm
      namespace: argocd
    data:
      extension.config.assistant: |
        services:
        - url: http://local.local.svc.cluster.local:11434
    ```

For an external provider that needs an API key, keep the key out of Git and out of the browser: put it in a labelled Secret and have the proxy inject the header - see [Injecting the API token](proxy.md#injecting-the-api-token).

## 3. Grant RBAC

Users need `invoke` on the `assistant` extension, and read access to the Application they are asking about. `role:readonly` covers the second part.

=== "Operator"

    ```yaml
    spec:
      rbac:
        policy: |
          g, system:cluster-admins, role:admin
          p, role:readonly, extensions, invoke, assistant, allow
    ```

=== "Helm"

    ```yaml
    configs:
      rbac:
        policy.default: role:readonly
        policy.csv: |
          p, role:readonly, extensions, invoke, assistant, allow
    ```

=== "Raw manifests"

    ```yaml
    apiVersion: v1
    kind: ConfigMap
    metadata:
      name: argocd-rbac-cm
      namespace: argocd
    data:
      policy.default: role:readonly
      policy.csv: |
        p, role:readonly, extensions, invoke, assistant, allow
    ```

## 4. Install the extension

The initContainer extracts the bundle into an `emptyDir`. `argocd-server` can only serve it if the same volume is mounted into the server container as well, which is the one step people miss.

=== "Operator"

    argocd-operator >= v0.18.0 honours `spec.server.volumeMounts`, which is where the server-side mount goes.

    ```yaml
    spec:
      server:
        initContainers:
          - name: extension-argocd-ai-assistant
            image: quay.io/argoprojlabs/argocd-extension-installer:v1.0.0
            securityContext:
              allowPrivilegeEscalation: false
            env:
              - name: EXTENSION_URL
                value: "https://github.com/saidsef/argocd-ai-assistant/releases/download/v2.10.0/extension-argocd-ai-assistant-v2.10.0.tar"
            volumeMounts:
              - name: extensions
                mountPath: /tmp/extensions/
        # The argocd-server container must mount the same volume.
        volumeMounts:
          - name: extensions
            mountPath: /tmp/extensions/
        volumes:
          - name: extensions
            emptyDir: {}
    ```

=== "Helm"

    The chart's `server.extensions` block creates the initContainer and mounts the shared volume into both containers, so there is no volume wiring to get wrong:

    ```yaml
    server:
      extensions:
        enabled: true
        extensionList:
          - name: argocd-ai-assistant
            env:
              - name: EXTENSION_URL
                value: "https://github.com/saidsef/argocd-ai-assistant/releases/download/v2.10.0/extension-argocd-ai-assistant-v2.10.0.tar"
    ```

    Defining the initContainer yourself instead works too, but then the server-side `server.volumeMounts` entry is yours to add - the block above is doing it for you.

=== "Raw manifests"

    ```yaml
    apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: argocd-server
      namespace: argocd
    spec:
      template:
        spec:
          initContainers:
            - name: extension-argocd-ai-assistant
              image: quay.io/argoprojlabs/argocd-extension-installer:v1.0.0
              securityContext:
                allowPrivilegeEscalation: false
              env:
                - name: EXTENSION_URL
                  value: "https://github.com/saidsef/argocd-ai-assistant/releases/download/v2.10.0/extension-argocd-ai-assistant-v2.10.0.tar"
              volumeMounts:
                - name: extensions
                  mountPath: /tmp/extensions/
          containers:
            - name: argocd-server
              # The server container must mount the SAME volume to serve the files
              # the initContainer extracted - without this the extension never loads.
              volumeMounts:
                - name: extensions
                  mountPath: /tmp/extensions/
          volumes:
            - name: extensions
              emptyDir: {}
    ```

## 5. Add the settings extension

The Assistant reads its model and endpoint from a second extension, delivered as a ConfigMap mounted into `argocd-server`. [Settings Extension](settings.md) has the ConfigMap and every field it accepts; this is where you mount it.

=== "Operator"

    ```yaml
    spec:
      server:
        volumes:
          - name: ai-assistant-settings
            configMap:
              name: argocd-ai-assistant-settings
        volumeMounts:
          - name: ai-assistant-settings
            mountPath: /tmp/extensions/resources/argocd-ai-assistant-settings
            readOnly: true
    ```

=== "Helm"

    ```yaml
    server:
      volumes:
        - name: ai-assistant-settings
          configMap:
            name: argocd-ai-assistant-settings
      volumeMounts:
        - name: ai-assistant-settings
          mountPath: /tmp/extensions/resources/argocd-ai-assistant-settings
          readOnly: true
    ```

=== "Raw manifests"

    ```yaml
    # add to the argocd-server Deployment patch from step 4
    spec:
      template:
        spec:
          containers:
            - name: argocd-server
              volumeMounts:
                - name: ai-assistant-settings
                  mountPath: /tmp/extensions/resources/argocd-ai-assistant-settings
                  readOnly: true
          volumes:
            - name: ai-assistant-settings
              configMap:
                name: argocd-ai-assistant-settings
    ```

## Worked examples

Each method has a complete, tested artefact in the repo, used by the kind harness on every run:

| Method | File |
|--------|------|
| Operator | [`examples/kind/operator-cr.yaml`](https://github.com/saidsef/argocd-ai-assistant/blob/main/examples/kind/operator-cr.yaml) |
| Helm | [`examples/argo-cd-values.yaml`](https://github.com/saidsef/argocd-ai-assistant/blob/main/examples/argo-cd-values.yaml), [`examples/kind/helm-values.yaml`](https://github.com/saidsef/argocd-ai-assistant/blob/main/examples/kind/helm-values.yaml) |
| Raw manifests | [`examples/kind/raw-cm-patch.yaml`](https://github.com/saidsef/argocd-ai-assistant/blob/main/examples/kind/raw-cm-patch.yaml), [`examples/kind/raw-server-patch.yaml`](https://github.com/saidsef/argocd-ai-assistant/blob/main/examples/kind/raw-server-patch.yaml) |

## Next steps

- [Proxy & Backend Configuration](proxy.md) - other backends, API token injection, TLS
- [Local Testing with kind](local-testing.md) - prove it on a throwaway cluster
- [Verification & Troubleshooting](verification.md)
