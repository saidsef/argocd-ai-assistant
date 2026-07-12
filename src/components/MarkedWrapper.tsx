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

// Wrap each code block (<pre>) with a container + copy button; inline <code> is untouched.
const COPY_BTN = '<button class="code-copy-btn" type="button" aria-label="Copy code">Copy</button>';
const addCopyButtons = (html: string): string =>
    html.replace(/<pre>/g, `<div class="code-block">${COPY_BTN}<pre>`).replace(/<\/pre>/g, '</pre></div>');

// Parse Markdown -> sanitised HTML with copy buttons. Kept pure so it can run in the state
// initializer (first paint) and the throttled effect (streaming) alike.
const parseMarkdown = (children: React.ReactNode): string => {
    const markdown = typeof children === "string" ? children.replace(/\n{3,}/g, "\n\n") : "";
    return DOMPurify.sanitize(addCopyButtons(marked.parse(markdown, { async: false })));
};

// While streaming, `children` grows every animation frame; re-parsing the whole answer each time is
// O(n) per frame. Throttle re-parses to one per THROTTLE_MS, always rendering the final text.
const THROTTLE_MS = 120;

const MarkedWrapper = ({
    children
}: {
    children: React.ReactNode
}) => {
    // Announce copy success to screen readers; the visible button only swaps its label.
    const [copied, setCopied] = React.useState(false);

    const onCopyClick = React.useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        const btn = (e.target as HTMLElement).closest('.code-copy-btn') as HTMLElement | null;
        if (!btn) return;
        const code = btn.parentElement?.querySelector('pre')?.textContent ?? '';
        if (!code || !navigator.clipboard) return;
        navigator.clipboard.writeText(code).then(() => {
            btn.textContent = 'Copied';
            setCopied(true);
            setTimeout(() => { btn.textContent = 'Copy'; setCopied(false); }, 1500);
        }).catch(() => {});
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

    return (
        <>
            <div className="marked-content" onClick={onCopyClick} dangerouslySetInnerHTML={{ __html: html }} />
            <span className="sr-only" role="status" aria-live="polite">{copied ? 'Code copied to clipboard' : ''}</span>
        </>
    );
};

export default React.memo(MarkedWrapper);
