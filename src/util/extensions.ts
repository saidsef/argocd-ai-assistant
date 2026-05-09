import { Settings, Styles } from "react-chatbotify";

export enum ExtensionScope {
    Resource = "resource",
    System = "system"
}

export const CHAT_STYLES: Styles = {
};

export const chatSettings = (chatHistoryKey: string): Settings => {
    return {
        general: {
            showFooter: false,
            showHeader: false,
            embedded: true
        },
        fileAttachment: {
            disabled: true
        },
        chatHistory: {
            disabled: false,
            storageKey: chatHistoryKey,
            storageType: "SESSION_STORAGE",
            autoLoad: true
        },
        chatWindow: {
            showScrollbar: true
        }
    };
};
