import * as React from "react";

interface State { message: string | null }

/**
 * Contains a render-time failure to the assistant tab.
 *
 * This component is mounted *inside* the Argo CD console, so an uncaught throw here does not just
 * break the assistant - it unmounts whatever part of Argo CD's tree contains it, and the user loses
 * the resource view they were reading. A boundary keeps the blast radius to this panel.
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
    state: State = { message: null };

    static getDerivedStateFromError(error: unknown): State {
        return { message: error instanceof Error ? error.message : String(error) };
    }

    componentDidCatch(error: unknown, info: unknown) {
        console.error("Argo CD AI Assistant crashed:", error, info);
    }

    render() {
        if (this.state.message === null) return this.props.children;
        return (
            <div className="chat-error" role="alert">
                <span>The assistant hit an unexpected error: {this.state.message}</span>
                <button
                    className="chat-error-retry"
                    onClick={() => this.setState({ message: null })}
                    aria-label="Reload the assistant"
                >
                    Reload
                </button>
            </div>
        );
    }
}
