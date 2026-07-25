import * as React from "react";
import DOMPurify from 'dompurify';
import { marked } from "marked";

// Open assistant links in a new tab with rel hardening. Post-sanitise; anchors only.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
    }
});

// `breaks` so a single newline renders as a line break: models emit line-per-item prose that
// CommonMark would otherwise reflow into one paragraph. Set once - marked.parse re-reads options
// on every call, and this runs several times a second while streaming.
marked.use({ gfm: true, breaks: true });

// Exactly the tags Markdown can produce, and nothing else.
//
// Replies are grounded in cluster data an attacker may influence (annotations, event messages, log
// lines), and marked passes raw HTML straight through. DOMPurify's *default* allow-list already
// blocks scripts and event handlers, but it permits <form>, <input>, <select> and <img> - enough to
// render a convincing credential prompt, or a tracking pixel that phones home, inside the Argo CD
// console. None of those are reachable from Markdown syntax, so nothing is lost by dropping them.
// Deliberately not annotated as DOMPurify.Config: the widened type matches the RETURN_TRUSTED_TYPE
// overload, and sanitize() would then be typed as returning TrustedHTML rather than a string.
const SANITIZE_CONFIG = {
    ALLOWED_TAGS: [
        'p', 'br', 'hr', 'span', 'div',
        'strong', 'em', 'del', 'code', 'pre', 'blockquote',
        'ul', 'ol', 'li',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'a'
    ],
    ALLOWED_ATTR: ['href', 'title', 'class', 'align', 'target', 'rel'],
    // Anchors are hardened above; block the javascript:/data: schemes outright.
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i
};

const parseMarkdown = (children: React.ReactNode): string => {
    const markdown = typeof children === "string" ? children.replace(/\n{3,}/g, "\n\n") : "";
    return DOMPurify.sanitize(marked.parse(markdown, { async: false }), SANITIZE_CONFIG);
};

// While streaming, `children` grows every animation frame; re-parsing the whole answer each time is
// O(n) per frame. Throttle re-parses to one per THROTTLE_MS, always rendering the final text.
const THROTTLE_MS = 120;

const MarkedWrapper = ({
    children
}: {
    children: React.ReactNode
}) => {
    // Announce copy outcome to screen readers; the visible button only swaps its label.
    const [copyState, setCopyState] = React.useState<"" | "copied" | "failed">("");
    const contentRef = React.useRef<HTMLDivElement>(null);

    const onCopyClick = React.useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        const btn = (e.target as HTMLElement).closest('.code-copy-btn') as HTMLElement | null;
        if (!btn) return;
        const code = btn.parentElement?.querySelector('pre')?.textContent ?? '';
        if (!code) return;
        const settle = (state: "copied" | "failed") => {
            btn.textContent = state === "copied" ? 'Copied' : 'Copy failed';
            setCopyState(state);
            setTimeout(() => { btn.textContent = 'Copy'; setCopyState(""); }, 1500);
        };
        // navigator.clipboard is undefined on insecure origins; say so rather than doing nothing.
        if (!navigator.clipboard) return settle("failed");
        navigator.clipboard.writeText(code).then(() => settle("copied"), () => settle("failed"));
    }, []);

    // Parse once synchronously so static/stored messages paint immediately (no throttle delay).
    const [html, setHtml] = React.useState(() => parseMarkdown(children));
    const lastParseRef = React.useRef(0);
    const mountedRef = React.useRef(false);

    React.useEffect(() => {
        // The lazy initializer already parsed the initial children, so skip the mount run.
        if (!mountedRef.current) {
            mountedRef.current = true;
            lastParseRef.current = performance.now();
            return;
        }
        const run = () => { lastParseRef.current = performance.now(); setHtml(parseMarkdown(children)); };
        const elapsed = performance.now() - lastParseRef.current;
        if (elapsed >= THROTTLE_MS) {
            run();
            return;
        }
        // Trailing edge: guarantees the final text renders once updates stop.
        const t = setTimeout(run, THROTTLE_MS - elapsed);
        return () => clearTimeout(t);
    }, [children]);

    // Wrap each code block with a container + copy button, as real DOM after sanitising.
    //
    // This used to be a string replace of <pre> before DOMPurify ran, which forced <button> to stay
    // in the allow-list and broke outright on model output containing `<pre class="...">` - the
    // closing tag matched, the opening tag did not, and the stray </div> corrupted the bubble.
    React.useLayoutEffect(() => {
        const root = contentRef.current;
        if (!root) return;
        for (const pre of Array.from(root.querySelectorAll('pre'))) {
            if (pre.parentElement?.classList.contains('code-block')) continue;
            const wrapper = document.createElement('div');
            wrapper.className = 'code-block';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'code-copy-btn';
            button.setAttribute('aria-label', 'Copy code');
            button.textContent = 'Copy';
            pre.replaceWith(wrapper);
            wrapper.append(button, pre);
        }
    }, [html]);

    return (
        <>
            <div ref={contentRef} className="marked-content" onClick={onCopyClick} dangerouslySetInnerHTML={{ __html: html }} />
            <span className="sr-only" role="status" aria-live="polite">
                {copyState === "copied" ? 'Code copied to clipboard' : copyState === "failed" ? 'Could not copy to clipboard' : ''}
            </span>
        </>
    );
};

export default React.memo(MarkedWrapper);
