import * as React from "react";
import { AssistantSettings, McpServerStatus, QueryProvider } from "../model/provider";
import { LlmProvider } from "../providers/llmProvider";
import { mcpConfigured, parseMcpServers } from "../util/util";

// Settings + provider bootstrap shared by both extension entry points. Reads the host-injected
// globalThis.argocdAssistantSettings, creates the query provider once, and derives the configured
// MCP server list plus the header-badge status getter.
//
// The settings global is written by the settings extension before this bundle's entry point runs, so
// one read at mount is enough. (There used to be a re-sync effect here, but it re-read the same
// object reference the initialiser had already stored, so setSettings always bailed - it never
// picked up a late injection, and it never polled or subscribed to make that possible.)
export function useAssistantSettings() {
    const [settings] = React.useState<AssistantSettings>(
        () => globalThis.argocdAssistantSettings ?? {}
    );
    const [provider] = React.useState<QueryProvider>(() => new LlmProvider());

    // Parsed once, not cast: the setting is hand-written and reaches us as `any`, and a bad entry
    // used to surface as a TypeError deep inside a query rather than as one missing server.
    const mcpServers = React.useMemo(() => parseMcpServers(settings.data?.mcpServers), [settings]);
    const mcpEnabled = mcpConfigured(mcpServers);
    // Stable identity so the caller can memoise the (allocating) status computation instead of
    // re-running it on every streamed frame.
    const getMcpStatus = React.useCallback(
        (): McpServerStatus[] => provider.getMcpStatus?.(mcpServers) ?? [],
        [provider, mcpServers]
    );

    return { settings, provider, mcpServers, getMcpStatus: mcpEnabled ? getMcpStatus : undefined };
}
