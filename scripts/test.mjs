// Unit-test runner: esbuild-bundle every `src/**/*.test.ts`, then hand the output to `node --test`.
//
// There is no test framework here on purpose. The repo ships two runtime dependencies and its build
// is already esbuild (via esbuild-loader), so bundling the tests with the same transpiler keeps the
// toolchain at one compiler and the install at one extra devDependency. `node:test` + `node:assert`
// cover everything these tests need.
//
// Scope is deliberately pure functions only - no DOM, no network, no React rendering. That is what
// keeps the suite in the low hundreds of milliseconds, which is the only reason it gets run on every
// change. Anything needing a DOM belongs in the kind end-to-end harness (examples/kind), not here.

import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcdir = join(root, "src");
const outdir = join(root, ".test-build");

// Recursively collect test entry points. Cheap enough that a glob dependency would not earn its keep.
async function findTests(dir) {
    const found = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...await findTests(path));
        else if (entry.name.endsWith(".test.ts")) found.push(path);
    }
    return found;
}

const entryPoints = await findTests(srcdir);
if (entryPoints.length === 0) {
    console.error("No *.test.ts files found under src/.");
    process.exit(1);
}

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
    entryPoints,
    outdir,
    outbase: srcdir,
    bundle: true,
    platform: "node",
    format: "esm",
    // package.json has no "type": "module", so a bundled `.js` would be parsed as CommonJS and the
    // ESM output would throw on its first `import`.
    outExtension: { ".js": ".mjs" },
    // Match webpack.config.js, so a syntax level that builds for the browser also builds here.
    target: "es2020",
    sourcemap: "inline",
    logLevel: "warning",
});

// Explicit file paths rather than the output directory: `node --test <dir>` resolves the argument as
// a module and fails with MODULE_NOT_FOUND. The mapping mirrors esbuild's outbase/outExtension.
const testFiles = entryPoints.map((entry) =>
    join(outdir, relative(srcdir, entry).replace(/\.ts$/, ".mjs"))
);

const node = spawn(process.execPath, ["--test", ...testFiles], { stdio: "inherit" });
node.on("exit", (code) => process.exit(code ?? 1));
