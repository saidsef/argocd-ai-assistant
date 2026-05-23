import * as React from "react";
import DOMPurify from 'dompurify';
import { marked } from "marked";

const MarkedWrapper = ({
    children
}: {
    children: React.ReactNode
}) => {
    const markdown = typeof children === "string" ?
        children
            .replace(/\n{3,}/g, "\n\n")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;") :
        "";
    const text = DOMPurify.sanitize(marked.parse(markdown, { async: false }));
    return (
        <div className="marked-content" dangerouslySetInnerHTML={{ __html: text }} />
    );
};

export default React.memo(MarkedWrapper);
