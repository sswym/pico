/**
 * Claude Code-style auto mode for Pi.
 *
 * The enforcement order is deliberately different from simple "auto reviewer" plugins:
 * permission deny/ask rules and deterministic hard-deny checks run before any fast-path allow.
 * Only read-only built-in tools bypass classification; every side-effecting action goes through the classifier.
 */

export * from "./classifier.ts";
export * from "./config.ts";
export * from "./constants.ts";
export * from "./extension.ts";
export * from "./hard-deny.ts";
export * from "./log.ts";
export * from "./model.ts";
export * from "./model-selector.ts";
export * from "./paths.ts";
export * from "./permissions.ts";
export * from "./state.ts";
export * from "./transcript.ts";
export * from "./types.ts";

import { createPiAutomode } from "./extension.ts";

export default createPiAutomode();
