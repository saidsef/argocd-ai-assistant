import { Params } from "react-chatbotify";
import { QueryContext, QueryProvider, QueryResponse } from "../model/provider";
import { getMappedHeaders } from "../util/util";

export class LlmProvider implements QueryProvider {

    setContext(_context: QueryContext) {
        return;
    }

    async query(context: QueryContext, prompt: string, params: Params): Promise<QueryResponse> {
        const settings = context.settings;
        const baseURL = settings.data?.baseURL || `https://${location.host}/extensions/assistant`;
        const model = settings.model;
        if (!model) {
            return {
                success: false,
                error: { status: 400, message: 'LLM model is not configured. Check extension settings (model field in argocdAssistantSettings).' },
            };
        }
        const apiKey = settings.data?.apiKey;

        const messages = this.buildMessages(context, prompt);

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        const argocdHeaders = getMappedHeaders(context.application, true);
        Object.entries(argocdHeaders).forEach(([key, value]) => {
            if (value) headers[key] = value;
        });

        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const body = JSON.stringify({
            model,
            messages,
            stream: true,
        });

        const response = await fetch(`${baseURL}/v1/chat/completions`, {
            method: 'POST',
            headers,
            body,
        });

        if (!response.ok || !response.body) {
            let message: string;
            switch (response.status) {
                case 401:
                    message = "Authentication failed (401). Check your API key or token in the extension settings.";
                    break;
                case 403:
                    message = "Access forbidden (403). Your API key or token does not have permission to use this model or endpoint.";
                    break;
                case 404:
                    message = "LLM endpoint not found (404). Check the baseURL in the extension settings.";
                    break;
                case 429:
                    message = "Rate limit exceeded (429). Too many requests — try again shortly.";
                    break;
                default:
                    message = response.status >= 500
                        ? `LLM backend error (${response.status}). The server returned an internal error.`
                        : (response.body ? await response.text() : response.statusText);
            }
            return {
                success: false,
                error: { status: response.status, message },
            };
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') continue;
                if (!data) continue;

                try {
                    const parsed = JSON.parse(data);
                    const content = parsed.choices?.[0]?.delta?.content;
                    if (content) {
                        text += content;
                        await params.streamMessage(text);
                    }
                    if (parsed.error) {
                        return {
                            success: false,
                            error: { status: 500, message: parsed.error.message || 'Unknown error' },
                        };
                    }
                } catch (_e) {
                    // ignore malformed chunks
                }
            }
        }

        return { success: true };
    }

    private buildMessages(context: QueryContext, prompt: string): Array<{ role: string; content: string }> {
        const messages: Array<{ role: string; content: string }> = [];

        if (context.attachments.length > 0) {
            let contextText = "Context:\n";
            for (const attachment of context.attachments) {
                const label = this.attachmentLabel(attachment.type);
                contextText += `\n[${label} - ${attachment.mimeType}]:\n${attachment.content}\n`;
            }
            messages.push({ role: 'system', content: contextText });
        }

        messages.push({ role: 'user', content: prompt });
        return messages;
    }

    private attachmentLabel(type: number): string {
        switch (type) {
            case 0: return 'Events';
            case 1: return 'Log';
            case 2: return 'Manifest';
            default: return 'Attachment';
        }
    }
}
