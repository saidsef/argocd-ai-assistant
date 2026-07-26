import * as React from "react";
import DOMPurify from 'dompurify';
import { marked } from "marked";
import { copyText, useCopyState } from "./useCopy";

const ABSOLUTE_URI = /^(?:https?|mailto):/i;

// Open *external* assistant links in a new tab with rel hardening. Post-sanitise; anchors only.
// Same-origin links (an Argo CD deep link like /applications/foo, or a #fragment) stay in the tab,
// which is where the user expects the console to navigate. target/rel are set only here and are not
// allow-listed below, so model output can neither supply nor override them.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
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

// Exactly the tags Markdown can produce, and nothing else.
//
// Replies are grounded in cluster data an attacker may influence (annotations, event messages, log
// lines), and marked passes raw HTML straight through. DOMPurify's *default* allow-list already
// blocks scripts and event handlers, but it permits <form>, <input>, <select> and <img> - enough to
// render a convincing credential prompt, or a tracking pixel that phones home, inside the Argo CD
// console. None of those are reachable from Markdown syntax, so nothing is lost by dropping them.
//
// `div`, `span` and `class` are dropped for the same reason, and they are not merely unnecessary:
// this component injects its own copy button and keys the click handler on `.code-copy-btn`, so
// allowing model output to carry classes on generic containers let it render a convincing fake Copy
// button over a `.sr-only` <pre> and put attacker-chosen text on the clipboard. Markdown produces no
// div/span at all, and the only class marked emits is `language-*` on <code>, which nothing styles.
// `align` stays: marked does emit it on table cells.
//
// Deliberately not annotated as DOMPurify.Config: the widened type matches the RETURN_TRUSTED_TYPE
// overload, and sanitize() would then be typed as returning TrustedHTML rather than a string.
const SANITIZE_CONFIG = {
    ALLOWED_TAGS: [
        'p', 'br', 'hr',
        'strong', 'em', 'del', 'code', 'pre', 'blockquote',
        'ul', 'ol', 'li',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'a'
    ],
    ALLOWED_ATTR: ['href', 'title', 'align'],
    // `align` is not a URL, but a custom ALLOWED_URI_REGEXP is applied to the value of *every*
    // attribute DOMPurify does not already consider URI-safe (`title` is on that default list;
    // `align` is not). So align="left" was tested as a URL, failed, and was dropped - which is why
    // Markdown table alignment silently never rendered despite being allow-listed. Declaring it
    // URI-safe exempts it from the URL test without widening the URL policy itself.
    ADD_URI_SAFE_ATTR: ['align'],
    // Anchors are hardened above; block javascript:/data: outright while still allowing the
    // same-origin links marked emits for relative paths and fragments - those used to be stripped,
    // leaving an underlined, clickable-looking, dead link. `//host` is excluded: it is external.
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|#|\/(?!\/))/i
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
    const [copyState, setCopyState] = useCopyState();
    const contentRef = React.useRef<HTMLDivElement>(null);

    const onCopyClick = React.useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        const btn = (e.target as HTMLElement).closest('.code-copy-btn') as HTMLElement | null;
        if (!btn) return;
        const code = btn.parentElement?.querySelector('pre')?.textContent ?? '';
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
