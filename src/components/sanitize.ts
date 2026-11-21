// The sanitiser policy for rendered model output, which only MarkedWrapper applies. It does not use
// React or the DOM, because DOMPurify does nothing without a `window` and tests could not exercise
// it. See docs/architecture.md#rendering.

/** Link targets outside the Argo CD console, which MarkedWrapper opens in a new tab. */
export const ABSOLUTE_URI = /^(?:https?|mailto):/i;

/** A fenced block's language is the only class worth keeping, because it labels the block. */
const LANGUAGE_CLASS = /^language-[A-Za-z0-9+#._-]{1,20}$/;

/**
 * Whether a class survives sanitising. Only a `language-*` class on `<code>` does, which stops
 * model output from imitating the extension's own copy button.
 */
export const keepClass = (tagName: string, value: string): boolean =>
    tagName === "CODE" && LANGUAGE_CLASS.test(value);

/**
 * DOMPurify settings that allow only the tags and attributes Markdown produces. Replies can quote
 * cluster data that an attacker controls, and marked passes raw HTML through. The object is not
 * typed as `DOMPurify.Config`, because that type makes `sanitize()` return `TrustedHTML`.
 */
export const SANITIZE_CONFIG = {
    ALLOWED_TAGS: [
        'p', 'br', 'hr',
        'strong', 'em', 'del', 'code', 'pre', 'blockquote',
        'ul', 'ol', 'li',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'a'
    ],
    ALLOWED_ATTR: ['href', 'title', 'align', 'class'],
    // DOMPurify tests every attribute outside its URI-safe list against ALLOWED_URI_REGEXP, which
    // would drop `align` and with it table alignment. See #123.
    ADD_URI_SAFE_ATTR: ['align'],
    // marked emits same-origin links as relative paths and fragments, which must keep working.
    // `javascript:`, `data:` and protocol-relative `//host` links do not match.
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|#|\/(?!\/))/i
};
