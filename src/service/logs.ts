import { LogEntry } from "../model/argocd";
import { getHeaders, Kinds } from "../util/util";

export const MAX_LINES = 250;

export function hasLogs(resource: any): boolean {
    return resource?.spec?.template?.spec?.containers || resource?.kind === Kinds.POD;
}

function getGroup(apiVersion: string): string {
    const index = apiVersion.indexOf("/");
    if (index > 0) return apiVersion.substring(0, index);
    else return apiVersion;
}

export const getLogs = async (application: any, resource: any, container: string, count: number): Promise<LogEntry[]> => {
    const params = new URLSearchParams({
        appNamespace: application.metadata.namespace,
        namespace: resource.metadata.namespace,
        container: container,
        tailLines: String(count),
        follow: "false",
        sinceSeconds: "0"
    });

    if (resource.kind == Kinds.POD) {
        params.append("podName", resource.metadata.name);
    } else {
        params.append("resourceName", resource.metadata.name);
        params.append("kind", resource.kind);
        params.append("group", getGroup(resource.apiVersion));
    }

    const url = "/api/v1/applications/" + application.metadata.name + "/logs?" + params.toString();

    const request: RequestInfo = new Request(url, {
        credentials: 'include',
        method: 'GET',
        headers: getHeaders(application)
    });

    const response = await fetch(request);
    if (!response.ok || !response.body) {
        throw new Error(`Failed to fetch data: ${response.status} ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let partialData = '';
    let index = 0;

    var results: LogEntry[] = [];

    while (index <= count) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }

        partialData += decoder.decode(value, { stream: true });
        const parts = partialData.split('\n');
        partialData = parts.pop() || '';

        for (const part of parts) {
            try {
                const jsonObject = JSON.parse(part);
                results.push(jsonObject as LogEntry);
                index++;
                if (index > count) break;
            } catch (e) {
                // Ignore incomplete JSON objects
            }
        }
    }

    return results;
};
