"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defineTool = defineTool;
/**
 * Declare one tool, tying its handler to its own schema.
 *
 * Annotating a list as `ToolDescriptor[]` cannot do this: it pins `I` to `unknown` for every entry,
 * so each tool's schema and handler are only ever checked against `unknown` and never against each
 * other. Inferring `I` per tool here means a handler that reads a field its schema does not declare
 * is a compile error, and the handler's parameter no longer has to be written out by hand — it is
 * whatever the schema produces, so the two cannot drift apart.
 */
function defineTool(descriptor) {
    return descriptor;
}
