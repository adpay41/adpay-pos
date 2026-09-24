// Metro config for the register.
//
// expo-sqlite's web build runs wa-sqlite (WebAssembly) in a worker, so Metro must serve .wasm.
// The register only uses expo-sqlite's async API, which talks to the worker by postMessage; the
// sync API would additionally need SharedArrayBuffer (a cross-origin-isolated page). Don't
// introduce sync SQLite calls without adding COOP/COEP. None of this affects the Android build.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

if (!config.resolver.assetExts.includes('wasm')) config.resolver.assetExts.push('wasm');

module.exports = config;
