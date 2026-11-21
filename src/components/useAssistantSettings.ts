import * as React from "react";
import { AssistantSettings, McpServerStatus, QueryProvider } from "../model/provider";
import { LlmProvider } from "../providers/llmProvider";
import { mcpConfigured, parseMcpServers } from "../util/util";

/**
 * Settings, query provider and MCP status shared by both extension entry points. One read of
 * `globalThis.argocdAssistantSettings` at mount is enough, because the settings extension writes it
 * before this bundle runs. See #123.
 */
export function useAssistantSettings(mcpToken?: string) {
    const [settings] = React.useState<AssistantSettings>(
        () => globalThis.argocdAssistantSettings ?? {}
    );
    const [provider] = React.useState<QueryProvider>(() => new LlmProvider());

    // Parsed rather than cast, because the setting is hand-written. A bad entry costs one server
    // instead of failing a query.
    const mcpServers = React.useMemo(() => parseMcpServers(settings.data?.mcpServers), [settings]);
    const mcpEnabled = mcpConfigured(mcpServers);

    // Connects as the tab opens, because each server's handle comes from its reported name, and the
    // welcome message suggests it. Bumping the counter makes the UI read it again.
    const [mcpProbe, setMcpProbe] = React.useState(0);
    React.useEffect(() => {
        if (!mcpEnabled) return;
        let live = true;
        provider.warmUpMcp?.(mcpServers, mcpToken).then(() => { if (live) setMcpProbe(n => n + 1); });
        return () => { live = false; };
        // mcpToken is a dependency because it arrives late: the resource extension creates its
        // storage in an effect, and the token flow can supply one mid-session. warmUpMcp no-ops when
        // a healthy client already exists, so a repeat call costs nothing.
    }, [provider, mcpServers, mcpEnabled, mcpToken]);

    // Stable identity so the caller can memoise the (allocating) status computation instead of
    // re-running it on every streamed frame. mcpProbe is in the deps so a completed warm-up (or
    // re-probe) invalidates it and the badge and welcome pick up the reported names.
    const getMcpStatus = React.useCallback(
        (): McpServerStatus[] => provider.getMcpStatus?.(mcpServers) ?? [],
        // eslint-disable-next-line -- mcpProbe is a deliberate invalidation trigger, not a value used here
        [provider, mcpServers, mcpProbe]
    );

    return { settings, provider, mcpServers, getMcpStatus: mcpEnabled ? getMcpStatus : undefined };
}
