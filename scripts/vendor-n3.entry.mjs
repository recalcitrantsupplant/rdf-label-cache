// Bundle entry for the self-hosted N3 browser build (see scripts/vendor-n3.sh).
// Re-export only what demo/public/demo.html actually uses, so the bundle stays
// minimal (esbuild tree-shakes to just this surface).
export { Parser } from "n3";
