import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keepClass } from "./sanitize";

// `class` is allow-listed in the sanitiser config so a fenced block's language survives to the DOM.
// This predicate is what narrows it back down, so it carries the whole security argument and is
// tested directly. (DOMPurify's application of it needs a DOM and is exercised in the browser.)
describe("keepClass", () => {
    it("keeps a language token on <code>", () => {
        for (const lang of ["yaml", "bash", "json", "sh", "dockerfile", "c++", "objective-c", "f#", "asp.net"]) {
            assert.equal(keepClass("CODE", `language-${lang}`), true, lang);
        }
    });

    it("strips the class that would fake this component's own copy button", () => {
        // The attack the sanitiser comment describes: a convincing Copy button over a hidden <pre>,
        // putting attacker-chosen text on the clipboard.
        assert.equal(keepClass("CODE", "code-copy-btn"), false);
        assert.equal(keepClass("CODE", "code-block"), false);
        assert.equal(keepClass("CODE", "language-yaml code-copy-btn"), false, "no multi-class smuggling");
    });

    it("keeps a language token on nothing but <code>", () => {
        for (const tag of ["PRE", "P", "A", "TD", "DIV", "SPAN", "H1"]) {
            assert.equal(keepClass(tag, "language-yaml"), false, tag);
        }
    });

    it("rejects anything that is not a language token", () => {
        for (const value of ["", " ", "language-", "lang-yaml", "Language-yaml", "sr-only", "argo-button"]) {
            assert.equal(keepClass("CODE", value), false, JSON.stringify(value));
        }
    });

    it("bounds the token length", () => {
        assert.equal(keepClass("CODE", `language-${"a".repeat(20)}`), true);
        assert.equal(keepClass("CODE", `language-${"a".repeat(21)}`), false);
    });

    it("rejects a value carrying whitespace or markup characters", () => {
        for (const value of ["language-yaml onerror=x", "language-ya ml", "language-<script>"]) {
            assert.equal(keepClass("CODE", value), false, value);
        }
    });
});
