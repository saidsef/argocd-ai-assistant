export type Events = {
    apiVersion: string,
    items: any[]
}

export interface LogEntry {
    content: string;
    timeStamp: string;
    first?: boolean;
    last: boolean;
    timeStampStr: string;
    podName: string;
}
