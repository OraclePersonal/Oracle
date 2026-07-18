#!/usr/bin/env node

/**
 * Oracle-templates — entry point.
 *
 * Exports the programmatic API for template management. Consumers can
 * import the functions directly or use the CLI via `src/cli.ts`.
 *
 * @module
 */

export * from "./types.js";
export * from "./utils.js";
export * from "./templates/index.js";
