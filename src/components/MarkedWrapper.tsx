import * as React from "react";
import DOMPurify from 'dompurify';
import { marked } from "marked";

// Assistant responses render inside the Argo CD single-page app. marked emits
// <a> without a target, so a link would open in the same tab and navigate the
// operator away from Argo CD. This hook runs after sanitisation - so the
// attributes always survive - and only decorates anchors; all other markup is
// left untouched. DOMPurify is used only here, so the module-level hook is scoped
// to this component's output.
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
