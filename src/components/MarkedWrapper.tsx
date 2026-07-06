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

    // Memoised so toggling copy state does not re-parse/re-sanitise the markdown.
    const text = React.useMemo(() => {
        const markdown = typeof children === "string" ? children.replace(/\n{3,}/g, "\n\n") : "";
        return DOMPurify.sanitize(addCopyButtons(marked.parse(markdown, { async: false })));
    }, [children]);
    return (
        <>
            <div className="marked-content" onClick={onCopyClick} dangerouslySetInnerHTML={{ __html: text }} />
            <span className="sr-only" role="status" aria-live="polite">{copied ? 'Code copied to clipboard' : ''}</span>
        </>
    );
};

export default React.memo(MarkedWrapper);
