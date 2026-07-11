import { mcpConfigured } from "./util/util";
import "./index.css"
import { ResourceAssistantExtension } from "./resourceExtension";
import { SystemAssistantExtension } from "./systemExtension";

export const resourceComponent = ResourceAssistantExtension;
export const systemComponent = SystemAssistantExtension;

((window: any) => {
    window?.extensionsAPI?.registerResourceExtension(resourceComponent, '**', '*', 'Assistant', { icon: 'fa-sharp fa-light fa-message fa-lg' });
    const mcpServers = (globalThis as any)?.argocdAssistantSettings?.data?.mcpServers;
    if (mcpConfigured(mcpServers)) {
         window?.extensionsAPI?.registerSystemLevelExtension(systemComponent, 'Assistant', "/assistant", 'fa-sharp fa-light fa-message fa-lg');
    }
})(window);
