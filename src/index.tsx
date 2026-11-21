import * as React from "react";
import { mcpConfigured, parseMcpServers } from "./util/util";
import "./index.css"
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ResourceAssistantExtension } from "./resourceExtension";
import { SystemAssistantExtension } from "./systemExtension";

/**
 * Each extension is wrapped where Argo CD mounts it, because both render inside the Argo CD
 * console, and an uncaught throw would otherwise unmount part of Argo CD's own tree.
 */
const guard = (Component: (props: any) => React.ReactNode) => (props: any) =>
    React.createElement(ErrorBoundary, null, React.createElement(Component, props));

export const resourceComponent = guard(ResourceAssistantExtension);
export const systemComponent = guard(SystemAssistantExtension);

((window: any) => {
    window?.extensionsAPI?.registerResourceExtension(resourceComponent, '**', '*', 'Assistant', { icon: 'fa-sharp fa-light fa-message fa-lg' });
    const mcpServers = parseMcpServers((globalThis as any)?.argocdAssistantSettings?.data?.mcpServers);
    if (mcpConfigured(mcpServers)) {
         window?.extensionsAPI?.registerSystemLevelExtension(systemComponent, 'Assistant', "/assistant", 'fa-sharp fa-light fa-message fa-lg');
    }
})(window);
