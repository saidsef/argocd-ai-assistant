# Questions for the Assistant

The Assistant answers questions about the resources and Applications that Argo CD manages. It reads live data through the Argo CD API with your own Argo CD permissions, and it says so when that data does not show the answer. Its built-in tools read but never change anything. When you have to act, it gives you a command to run.

## Resource tab

Every resource's slide-out panel has an **Assistant** tab, the Application's own panel included. Each question carries the resource's live manifest, a summary of its Application, its events and, where they apply, its pods and OutOfSync fields. The Assistant can also read the rest of that Application on its own.

| Kind of question | Example | What the Assistant reads |
|---|---|---|
| Health and status | Is this Deployment healthy? | the attached manifest, pods and events |
| Crashes and restarts | Why does this pod keep restarting? | pod states, and logs from the instance before its last restart |
| Errors in logs | Are there any errors in the logs? | recent log lines, searched for a string such as `error` |
| Related resources | Which port does the Service in front of this Deployment send traffic to? | the related resource's live manifest and events |
| Drift | Why is this resource OutOfSync? | the fields that differ from the target state |
| Changes | What changed in the last deployment? | recent deployments with their commit messages or chart details, and the result of the last sync |
| Time | How long ago did this Application last sync? | the current time, compared with timestamps in the context |
| Argo CD and Kubernetes | What does a sync wave do? | the model's own knowledge |

To send one container's recent logs with every question, type `attach`. [Conversation commands](architecture.md#conversation-commands) lists the commands.

## Assistant page

When the settings list MCP servers, the Argo CD sidebar also has an **Assistant** page at `/assistant`. It is not tied to one resource. A question names the Application it is about.

| Kind of question | Example | What the Assistant reads |
|---|---|---|
| Overview | Are any Applications unhealthy or OutOfSync? | every Application you can read, with its sync status and health |
| One Application | What changed in the last deployment of shop? | the named Application's recent deployments and last sync |
| Resources in an Application | Why is the api Deployment in shop not ready? | the named Application's resources, events and logs |
| Argo CD and Kubernetes | How do I roll back an Application? | the model's own knowledge |

## MCP servers

Name an MCP server in a question, as in `docs, what does a sync wave do?`. That question and the next one can then use the server's tools. The welcome message and the header badge show each server's name. [Addressing a server](architecture.md#addressing-a-server) describes how the Assistant matches a name.

Ask "Which tools do you have?" to see every built-in tool and every MCP tool that the Assistant can use.

## Limits

- The built-in tools cannot sync, roll back, delete or edit anything. An MCP server's tools do whatever that server offers.
- In the resource tab, it reads only the Application that the open resource belongs to. Ask about other Applications on the Assistant page.
- It reads only what your Argo CD account can read.
- Each question runs a limited number of tools. Split a question that needs many lookups into several.
- It answers from the data it reads and from general knowledge, and it does not guess a value that the data does not show.

[Built-in tools](architecture.md#built-in-tools) describes the tools behind these answers.
