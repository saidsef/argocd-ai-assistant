import * as React from "react";
import { AssistantSettings, McpServerStatus, QueryProvider } from "../model/provider";
import { createProvider } from "../providers/providerFactory";
import { mcpConfigured } from "../util/util";

// Settings + provider bootstrap shared by both extension entry points. Seeds state from the
// host-injected globalThis.argocdAssistantSettings (re-syncing once on mount), creates the query
// provider once, and derives the configured MCP server list plus the header-badge status getter.
export function useAssistantSettings() {
    const [settings, setSettings] = React.useState<AssistantSettings>(
        globalThis.argocdAssistantSettings ?? { provider: "LLM" }
    );
    const [provider] = React.useState<QueryProvider>(createProvider);

    React.useEffect(() => {
        if (globalThis.argocdAssistantSettings) {
            setSettings(globalThis.argocdAssistantSettings);
        }
    }, []);

    const mcpServers = settings.data?.mcpServers as string[] | undefined;
    const mcpEnabled = mcpConfigured(mcpServers);
    // Recomputed each render so the badge upgrades to live names/tools once a query connects.
    const getMcpStatus = mcpEnabled
        ? (): McpServerStatus[] => provider.getMcpStatus?.(mcpServers!) ?? []
        : undefined;

    return { settings, provider, mcpServers, mcpEnabled, getMcpStatus };
}
