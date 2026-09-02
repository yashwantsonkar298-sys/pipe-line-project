/**
 * Claude tool definitions for the assistant, derived from the Action Registry.
 * One tool per registry action that opts in via `aiName`; the tool's
 * input_schema IS the action's param schema, so the same validation runs for
 * an AI call and an HTTP call.
 */

import { listAiTools, intentForAiTool } from '../actions/registry.js';

export function buildTools() {
  return listAiTools();
}

export { intentForAiTool };
