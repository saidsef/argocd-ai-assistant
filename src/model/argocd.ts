export type Events = {
    apiVersion: string,
    items: any[]
}

/**
 * One entry from the Argo CD pod-logs stream, i.e. the `result` of each grpc-gateway envelope.
 * Every field is optional in practice: the stream's terminating entry carries only `last` and a
 * timestamp, and `podName` is empty when the container could not be resolved.
 */
export interface LogEntry {
    content?: string;
    timeStamp?: string;
    last?: boolean;
    podName?: string;
}
