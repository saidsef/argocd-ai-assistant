export type Events = {
    items: any[]
}

/**
 * One entry from the Argo CD pod-logs stream, i.e. the `result` of each grpc-gateway envelope.
 * Every field is optional in practice: the stream's terminating entry carries no content, and
 * `podName` is empty when the container could not be resolved.
 */
export interface LogEntry {
    content?: string;
    timeStamp?: string;
    podName?: string;
}
