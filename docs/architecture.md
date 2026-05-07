### Introduction

Argo CD enables extending the User Interface (UI) it provides via an
[extension](https://argo-cd.readthedocs.io/en/latest/developer-guide/extensions/ui-extensions/) mechanism.
The Assistant for Argo CD uses the
[Resource Tab Extension](https://argo-cd.readthedocs.io/en/latest/developer-guide/extensions/ui-extensions/#resource-tab-extensions) to provide
an additional tab on the Resource slide-out that appears when a Resource is clicked in the UI.

To provide the query functionality the Assistant supports a generic LLM provider that interfaces with any OpenAI-compatible inference backend:

- **Generic LLM** — Uses standard OpenAI-compatible chat completions API. Works with Local Inference Server, vLLM, OpenAI, Azure OpenAI, or any other OpenAI-compatible endpoint.

It was a conscious decision when creating this tool to focus on a generic OpenAI-compatible API rather than tying to specific backends. This allows maximum flexibility in choosing inference providers while maintaining a simple, unified interface.

### Architecture

The extension is composed of two main parts: the UI extension bundle (JavaScript/React) loaded by the Argo CD server, and the backend LLM service accessed through the Argo CD Proxy Extension.

```
 +-------------------+        +------------------------+        +------------------+
 |   User Browser    |        |   Argo CD Server Pod   |        |   LLM Backend    |
 |                   |        |                        |        |                  |
 |  Argo CD UI  +----------> |  Extension JS Bundle   |        |  (OpenAI-compat) |
 |                   |   |    |  (/tmp/extensions/...) |        |                  |
 |  Assistant Tab    |   |    |                        |        |  Local/Ollama    |
 |  (React Chatbot)  |   |    |  Proxy Extension       +------> |  vLLM            |
 |                   |   |    |  (/extensions/assistant)       |  OpenAI          |
 |  Attach Logs      |   |    |                        |        |  DeepSeek        |
 |  (guided flow)    |   |    |  Settings ConfigMap    |        |  Azure           |
 +-------------------+   |    |  (argocd-ai-assistant-  |        +------------------+
                         |    |   settings)            |
                         |    +------------------------+
                         |
                         +--> Argo CD API (events, logs, manifests)
```

**Communication flow:**

1. The Argo CD server loads the extension JS bundle via an initContainer at startup.
2. When a user opens a resource and clicks the **Assistant** tab, the extension renders a chatbot interface.
3. The extension fetches the resource manifest (provided by Argo CD), events (via Argo CD API), and optionally container logs.
4. User queries + context are sent to the LLM backend through the Argo CD [Proxy Extension](https://argo-cd.readthedocs.io/en/stable/developer-guide/extensions/proxy-extensions/), avoiding CORS issues.
5. The proxy forwards requests to the configured LLM service. Responses stream back via SSE.

Argo CD leverages Cross-Origin Resource Sharing (CORS) to prevent malicious extensions or code from
communicating outside of the domain being used for the UI. In order to communicate with the back-end
the extension leverages the Argo CD Proxy Extension to do so.

The Proxy Extension enables traffic intended for the back-end such as LLM to be proxied through the argocd-server pod fulfilling CORS
requirements. Streaming responses are handled natively by the proxy without additional client-side header workarounds.

### Query Context

The Assistant provides additional context when queries are sent to the back-end and on to the inference provider.

1. Resource Manifest. The live resource manifest is provided to enable queries, this manifest is provided by
Argo CD automatically when the extension is invoked.
2. Events. The Assistant will automatically retrieve the resource Events and attach them to the context. The
Events are currently cached and are not continuously updated.
3. Logs (Optional). If the resource supports logs, a log file from a single container can be attached to the
context via a guided conversation flow. Once attached the logs are cached and provided on every request, logs
can be re-fetched by initiating the flow again.

!!! note
    It's important to note that most inference providers support a limited amount of tokens. As a result larger
    context items might exhaust the query token limit.

### Chatbot Interface

This extension uses the [React ChatBotify](https://react-chatbotify.com/) React component for the chat interface.
This component provides support for a variety of features including streaming, markdown rendering and more.

Following the architecture of React ChatBotify the Assistant Extension defines a conversation flow as follows:


1. When the user first interacts with the Assistant they begin at the Start node. Here the Assistant provides
a starting message including some information about the resource like Kind and Name. Optionally if
the resource is of a type that supports Logs it will include a message on how to begin the Attach Logs
guided conversation flow.
2. After the Start node, the user enters the Loop Node where they can enter queries. The Loop Node, as the name
implies, loops on itself after every query. Users can opt to go to other flows by entering a keyword.
3. Entering the `attach` keyword will start the Attach Logs guided conversation flow. The Chatbot will prompt
the user with a list of containers from which they can select one container for which to attach logs. Next they
are prompted to select the number of lines to attach to maximum configurable limit.
4. If the MCP feature flag is enabled (off by default), a `token` flow can be initiated by the user to provide an Argo CD API token. The token is stored in `sessionStorage` and can be used by an MCP server such as [mcp-for-argocd](https://github.com/saidsef/mcp-for-argocd) to interact with Argo CD on the user's behalf.

While React ChatBotify does have direct support for LLM providers these are not used as additional features
were needed over and above what the component provided such as attaching context.
