import * as React from "react";
import DOMPurify from 'dompurify';
import { marked } from "marked";
import { ABSOLUTE_URI, keepClass, SANITIZE_CONFIG } from "./sanitize";
import { copyText, useCopyState } from "./useCopy";

// Post-sanitise hardening, applied to every node:
//  - drop any class that is not a fenced-block language token (see keepClass in ./sanitize);
//  - open *external* assistant links in a new tab with rel hardening. Same-origin links (an Argo CD
//    deep link like /applications/foo, or a #fragment) stay in the tab, which is where the user
//    expects the console to navigate. target/rel are set only here and are not allow-listed in
//    SANITIZE_CONFIG, so model output can neither supply nor override them.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const className = node.getAttribute?.('class');
    if (className != null && !keepClass(node.tagName, className)) {
        node.removeAttribute('class');
    }
    if (node.tagName !== 'A') return;
    const href = node.getAttribute('href');
    if (href && ABSOLUTE_URI.test(href)) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
    }
});

// `breaks` so a single newline renders as a line break: models emit line-per-item prose that
// CommonMark would otherwise reflow into one paragraph. Set once - marked.parse re-reads options
// on every call, and this runs several times a second while streaming.
marked.use({ gfm: true, breaks: true });

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
    const [copyState, setCopyState] = useCopyState();
    const contentRef = React.useRef<HTMLDivElement>(null);

    const onCopyClick = React.useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        const btn = (e.target as HTMLElement).closest('.code-copy-btn') as HTMLElement | null;
        if (!btn) return;
        // Resolved from the block, not the button's parent: the button now sits inside an actions
        // cluster alongside the language label, so parentElement is no longer the wrapper.
        const code = btn.closest('.code-block')?.querySelector('pre')?.textContent ?? '';
        if (!code) return;
        copyText(code).then((state) => {
            // The label lives on injected DOM, which a re-parse replaces - so only touch it while
            // the node is still in the document, and let the live region carry the outcome.
            if (btn.isConnected) {
                btn.textContent = state === "copied" ? 'Copied' : 'Copy failed';
                btn.setAttribute('aria-label', state === "copied" ? 'Code copied' : 'Copy code failed');
            }
            setCopyState(state, () => {
                if (!btn.isConnected) return;
                btn.textContent = 'Copy';
                btn.setAttribute('aria-label', 'Copy code');
            });
        });
    }, [setCopyState]);

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

    // Wrap each code block with a container, a language label and a copy button, as real DOM after
    // sanitising.
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

            // Both controls live in one absolutely-positioned cluster, so they stay pinned to the
            // top-right when a long line scrolls the <pre> underneath them.
            const actions = document.createElement('div');
            actions.className = 'code-block-actions';

            // The sanitiser lets exactly one class through here - `language-*` on <code> - so this
            // reads the fence's info string and nothing an attacker chose. See keepClass.
            const language = pre.querySelector('code')?.getAttribute('class')?.replace(/^language-/, '');
            if (language) {
                const tag = document.createElement('span');
                tag.className = 'code-lang';
                tag.textContent = language;
                actions.append(tag);
            }

            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'code-copy-btn';
            button.setAttribute('aria-label', 'Copy code');
            button.textContent = 'Copy';
            actions.append(button);

            pre.replaceWith(wrapper);
            wrapper.append(actions, pre);
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
