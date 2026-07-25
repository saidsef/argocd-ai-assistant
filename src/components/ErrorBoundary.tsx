import * as React from "react";
import { errorMessage } from "../util/util";

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
        return { message: errorMessage(error) };
    }

    componentDidCatch(error: unknown, info: unknown) {
        console.error("Argo CD AI Assistant crashed:", error, info);
    }

    render() {
        if (this.state.message === null) return this.props.children;
        return (
            // Its own class, not .chat-error: this renders in place of the whole extension, so it
            // sits *outside* the #chatbot-* element every other rule in index.css is scoped to -
            // which meant the crash message, the one time styling matters most, was unstyled.
            <div className="chat-boundary-error" role="alert">
                <span>The assistant hit an unexpected error: {this.state.message}</span>
                <button
                    type="button"
                    onClick={() => this.setState({ message: null })}
                    aria-label="Reload the assistant"
                >
                    Reload
                </button>
            </div>
        );
    }
}
