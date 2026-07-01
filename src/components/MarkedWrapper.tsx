import * as React from "react";
import DOMPurify from 'dompurify';
import { marked } from "marked";

// Open assistant links in a new tab (they render inside the Argo CD SPA) and
// harden them. Post-sanitise, so the attributes survive; anchors only.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
    }
});

const MarkedWrapper = ({
    children
}: {
    children: React.ReactNode
}) => {
    const markdown = typeof children === "string" ?
        children.replace(/\n{3,}/g, "\n\n") :
        "";
    const text = DOMPurify.sanitize(marked.parse(markdown, { async: false }));
    return (
        <div className="marked-content" dangerouslySetInnerHTML={{ __html: text }} />
    );
};

export default React.memo(MarkedWrapper);
