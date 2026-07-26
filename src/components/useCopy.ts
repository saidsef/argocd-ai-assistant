import * as React from "react";

export type CopyState = "" | "copied" | "failed";

/**
 * Copy `text` to the clipboard, resolving with the outcome rather than rejecting.
 * `navigator.clipboard` is undefined on insecure origins, so "unavailable" is reported as a failure
 * the user can see instead of the button silently doing nothing.
 */
export async function copyText(text: string): Promise<"copied" | "failed"> {
    if (!text || !navigator.clipboard) return "failed";
    try {
        await navigator.clipboard.writeText(text);
        return "copied";
    } catch (_e) {
        return "failed";
    }
}

const RESET_MS = 1500;

/**
 * Transient copy state for a live region, auto-clearing after RESET_MS.
 *
 * The timer is owned here and cancelled on unmount and on each new copy: the previous inline version
 * never stored its handle, so a copy followed by a re-parse (the streaming bubble re-renders several
 * times a second) or an unmount left a callback writing to a detached node and setting state on a
 * component that was gone. `onReset` runs alongside the state clear for callers that also have
 * imperative DOM to restore.
 */
export function useCopyState(): [CopyState, (state: CopyState, onReset?: () => void) => void] {
    const [state, setState] = React.useState<CopyState>("");
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    React.useEffect(() => () => clearTimeout(timerRef.current), []);

    const announce = React.useCallback((next: CopyState, onReset?: () => void) => {
        clearTimeout(timerRef.current);
        setState(next);
        if (!next) return;
        timerRef.current = setTimeout(() => {
            setState("");
            onReset?.();
        }, RESET_MS);
    }, []);

    return [state, announce];
}
