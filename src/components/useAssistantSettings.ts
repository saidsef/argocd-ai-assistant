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
export function useAssistantSettings(mcpToken?: string) {
    const [settings] = React.useState<AssistantSettings>(
        () => globalThis.argocdAssistantSettings ?? {}
    );
    const [provider] = React.useState<QueryProvider>(() => new LlmProvider());

    // Parsed once, not cast: the setting is hand-written and reaches us as `any`, and a bad entry
    // used to surface as a TypeError deep inside a query rather than as one missing server.
    const mcpServers = React.useMemo(() => parseMcpServers(settings.data?.mcpServers), [settings]);
    const mcpEnabled = mcpConfigured(mcpServers);

    // Connect as the tab opens rather than on the first message. A server's short handle - shown on
    // the badge, suggested in the welcome message and used by the roster - comes from the name it
    // reports during the handshake, so without this the user is told to type a URL hostname until
    // they have already sent a message. Bumping the counter is what lets the UI re-read the result.
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
