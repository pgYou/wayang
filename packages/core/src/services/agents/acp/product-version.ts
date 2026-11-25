/**
 * The product version reported in MCP protocol frames (initialize
 * `serverInfo`), shared by the bridge entry and the host socket endpoint.
 *
 * The shipped product is the CLI app (@wayang-ai/cli): its tsup build bakes
 * the app version into every bundle as the build-time constant below (esbuild
 * `define`). Everywhere else — core's own dist, source runs, tests — the
 * constant is absent and this falls back to the core package version.
 */

import pkg from '../../../../package.json';

declare const __WAYANG_PRODUCT_VERSION__: string | undefined;

export const PRODUCT_VERSION: string =
  typeof __WAYANG_PRODUCT_VERSION__ !== 'undefined'
    ? __WAYANG_PRODUCT_VERSION__
    : pkg.version;
