import { Settings, Styles } from "react-chatbotify";

export enum ExtensionScope {
    Resource = "resource",
    System = "system"
}

export const CHAT_STYLES: Styles = {
    botBubbleStyle: {
        backgroundColor: "#6D7F8B",
        color: "#F8F8FB"
    },
    userBubbleStyle: {
        background: "#00A2B3",
        color: "#ffffff"
    }
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
