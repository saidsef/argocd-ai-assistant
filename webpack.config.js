/* eslint-env node */

const path = require("path");

const PACKAGE = require('./package.json');
// VERSION env var overrides package.json version for CI builds
const version = process.env.VERSION || PACKAGE.version;
const extName = PACKAGE.name;

/** @type {import('webpack').Configuration} */
const config = {
    mode: "development",
    entry: {
        extension: './src/index.tsx',
    },
    output: {
        filename: `extensions-${extName}.js`,
        path: __dirname + `/dist/resources/extensions-${extName}`,
        libraryTarget: 'window',
        library: ['extensions', 'resources'],
    },
    resolve: {
        extensions: ['.ts', '.tsx', '.js', '.json', '.ttf', '.scss']
    },
    externals: {
        react: 'React',
    },
    optimization: {
        usedExports: true,
        sideEffects: true,
    },
    module: {
        rules: [
            {
                // esbuild-loader transpiles TS/TSX (no TypeScript programmatic API
                // needed, so it works with the native TS 7.0 compiler). Types are
                // checked separately via `tsc --noEmit` (see the `typecheck` script).
                // jsx/target are read from tsconfig.json (jsx: "react" -> classic
                // React.createElement, matching the `react` external below).
                test: /\.tsx?$/,
                loader: 'esbuild-loader',
                options: {
                    target: 'es2020',
                    tsconfig: path.resolve('./tsconfig.json'),
                },
            },
            {
                test: /\.scss$/,
                use: ['style-loader', 'raw-loader', 'sass-loader'],
            },
            {
                test: /\.css$/,
                use: ['style-loader', 'css-loader'],
            },
        ],
    },
};

if (process.env.NODE_ENV === "production") {
    config.mode = "production";
    if (config.output) {
        config.output.filename = `extension-${extName}-bundle-${version}.min.js`;
        config.output.chunkFilename = '[name]-chunk-[chunkhash].min.js';
    }
    if (config.optimization) {
        config.optimization.chunkIds = 'deterministic';
        config.optimization.minimize = true;
    }
    config.devtool = false;
}

module.exports = config;
