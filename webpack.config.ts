/// <reference types="node" />
/* eslint-env node */

import type { Configuration as WebpackConfiguration } from "webpack";
import * as path from "path";

var PACKAGE = require('./package.json');
// VERSION env var overrides package.json version for CI builds
var version = process.env.VERSION || PACKAGE.version;
const extName = PACKAGE.name;

const config: WebpackConfiguration = {
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
                test: /\.tsx?$/,
                loader: 'ts-loader',
                options: {
                    allowTsInNodeModules: true,
                    configFile: path.resolve('./tsconfig.json')
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

export default config;
