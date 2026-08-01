// The sanitiser policy for rendered model output: what survives, and what is stripped.
//
// Kept apart from MarkedWrapper because this is the security-relevant half and it is pure - no
// React, no DOMPurify, no DOM - so it can be exercised directly. (DOMPurify itself needs a `window`
// and is a no-op without one, so a test importing the component would either fail to load or, worse,
// pass vacuously against an unsanitising stub.) MarkedWrapper applies these; nothing else should.

export const ABSOLUTE_URI = /^(?:https?|mailto):/i;

// The only class Markdown produces is `language-*` on <code>, from a fenced block's info string.
// That one is worth keeping - replies here are overwhelmingly YAML manifests and kubectl commands,
// and the language is what lets a block be labelled - but nothing else is.
//
// This predicate carries the whole argument for allow-listing `class` at all: every class that is
// not a language token on a <code> is removed again by MarkedWrapper's hook. `div` and `span` are
// not allowed tags, so <code> is the only element that can carry a class, and
// `<code class="code-copy-btn">` fails this test - which is what keeps model output from rendering a
// convincing fake Copy button (see ALLOWED_TAGS below).
const LANGUAGE_CLASS = /^language-[A-Za-z0-9+#._-]{1,20}$/;

export const keepClass = (tagName: string, value: string): boolean =>
    tagName === "CODE" && LANGUAGE_CLASS.test(value);

// Exactly the tags Markdown can produce, and nothing else.
//
// Replies are grounded in cluster data an attacker may influence (annotations, event messages, log
// lines), and marked passes raw HTML straight through. DOMPurify's *default* allow-list already
// blocks scripts and event handlers, but it permits <form>, <input>, <select> and <img> - enough to
// render a convincing credential prompt, or a tracking pixel that phones home, inside the Argo CD
// console. None of those are reachable from Markdown syntax, so nothing is lost by dropping them.
//
// `div` and `span` are dropped for the same reason, and they are not merely unnecessary:
// MarkedWrapper injects its own copy button and keys the click handler on `.code-copy-btn`, so
// letting model output carry classes on generic containers would let it render a convincing fake
// Copy button over a `.sr-only` <pre> and put attacker-chosen text on the clipboard. Markdown
// produces no div/span at all.
//
// `class` is allow-listed here but immediately narrowed by the hook to `language-*` on <code> only -
// see keepClass. With no generic container left to put a class on, that attack has nowhere to land.
// (`class` is on DOMPurify's default URI-safe list, so unlike `align` it needs no
// ADD_URI_SAFE_ATTR entry.)
//
// Deliberately not annotated as DOMPurify.Config: the widened type matches the RETURN_TRUSTED_TYPE
// overload, and sanitize() would then be typed as returning TrustedHTML rather than a string.
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
    // `align` is not a URL, but a custom ALLOWED_URI_REGEXP is applied to the value of *every*
    // attribute DOMPurify does not already consider URI-safe (`title` is on that default list;
    // `align` is not). So align="left" was tested as a URL, failed, and was dropped - which is why
    // Markdown table alignment silently never rendered despite being allow-listed. Declaring it
    // URI-safe exempts it from the URL test without widening the URL policy itself.
    ADD_URI_SAFE_ATTR: ['align'],
    // Anchors are hardened in the hook; block javascript:/data: outright while still allowing the
    // same-origin links marked emits for relative paths and fragments - those used to be stripped,
    // leaving an underlined, clickable-looking, dead link. `//host` is excluded: it is external.
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|#|\/(?!\/))/i
};
