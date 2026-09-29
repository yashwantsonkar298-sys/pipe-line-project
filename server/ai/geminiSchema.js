/**
 * Translate our JSON Schemas into the OpenAPI subset Gemini accepts.
 *
 * Gemini's `FunctionDeclaration.parameters` supports only `type`, `description`,
 * `enum`, `properties`, `required`, `items` and nesting. Our tool schemas also
 * use `minimum`, `maximum`, `minLength`, `maxLength` and
 * `additionalProperties: false` — sending those is rejected.
 *
 * Nothing is actually lost by stripping them: `security.assertJsonSchema` still
 * validates every tool input against the *real* schema before any primitive
 * touches the phone. The model just needs to be told the bounds in prose
 * instead, which is what `describeConstraints` does — otherwise it would be
 * guessing at, say, whether coordinates are pixels or fractions.
 */

const SUPPORTED = new Set(['type', 'description', 'enum', 'properties', 'required', 'items', 'nullable']);

/** Human-readable version of the keywords Gemini will not accept. */
function describeConstraints(schema) {
  const parts = [];
  const { type, minimum, maximum, minLength, maxLength } = schema;

  if (typeof minimum === 'number' && typeof maximum === 'number') {
    parts.push(`${minimum}-${maximum}`);
  } else if (typeof minimum === 'number') {
    parts.push(`at least ${minimum}`);
  } else if (typeof maximum === 'number') {
    parts.push(`at most ${maximum}`);
  }

  if (typeof maxLength === 'number') {
    parts.push(minLength ? `${minLength}-${maxLength} characters` : `max ${maxLength} characters`);
  } else if (typeof minLength === 'number' && minLength > 0) {
    parts.push(`at least ${minLength} character${minLength === 1 ? '' : 's'}`);
  }

  if (type === 'integer') parts.push('whole number');

  return parts.join(', ');
}

function mergeDescription(existing, constraints) {
  if (!constraints) return existing || undefined;
  if (!existing) return constraints;
  // Don't repeat a bound the description already spells out.
  return existing.includes(constraints) ? existing : `${existing} (${constraints})`;
}

/**
 * @param {object} schema a JSON Schema fragment
 * @returns {object} the same shape with only Gemini-supported keywords
 */
export function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'string' };

  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (SUPPORTED.has(key)) out[key] = value;
  }

  // `integer` is not in Gemini's type set; it is a number with a note.
  if (out.type === 'integer') out.type = 'number';

  const constraints = describeConstraints(schema);
  const description = mergeDescription(schema.description, constraints);
  if (description) out.description = description;

  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const [name, child] of Object.entries(schema.properties)) {
      out.properties[name] = toGeminiSchema(child);
    }
  }

  if (schema.items) out.items = toGeminiSchema(schema.items);

  if (Array.isArray(schema.required) && schema.required.length) {
    out.required = [...schema.required];
  } else {
    delete out.required;
  }

  // An object with no declared properties still needs the key, or Gemini
  // rejects the declaration.
  if (out.type === 'object' && !out.properties) out.properties = {};

  return out;
}

/**
 * Project our internal tool list into Gemini function declarations.
 * Accepts the `{name, description, input_schema}` shape that both
 * `actions/registry.js` and `agent/tools.js` already produce.
 */
export function toGeminiTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description || tool.name,
    parameters: toGeminiSchema(tool.input_schema || { type: 'object', properties: {} })
  }));
}
