import { FeatureFlags, isFeatureEnabled } from "./featureFlags";
import "./index.css"
import { ResourceAssistantExtension } from "./resourceExtension";
import { SystemAssistantExtension } from "./systemExtension";

export const resourceComponent = ResourceAssistantExtension;
export const systemComponent = SystemAssistantExtension;

((window: any) => {
    window?.extensionsAPI?.registerResourceExtension(resourceComponent, '**', '*', 'Assistant', { icon: 'fa-sharp fa-light fa-message fa-lg' });
    if (isFeatureEnabled(FeatureFlags.ArgoCDMCP)) {
         window?.extensionsAPI?.registerSystemLevelExtension(systemComponent, 'Assistant', "/assistant", 'fa-sharp fa-light fa-message fa-lg');
    }
})(window);
