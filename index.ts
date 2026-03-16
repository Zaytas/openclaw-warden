// Root entry-point shim for OpenClaw plugin discovery.
// OpenClaw's plugin scanner looks for a root-level module export;
// this re-exports the built default as the expected named `register` export.
export { default as register } from "./dist/index.js";
