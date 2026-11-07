// Gemini helper functions for translator

import { safeParseJSON } from "../concerns/json.js";
import { OPENAI_BLOCK } from "../schema/index.js";
import { isGemini4Model } from "../../providers/modelFamilies.js";

// Unsupported JSON Schema constraints that should be removed for Antigravity
export const UNSUPPORTED_SCHEMA_CONSTRAINTS = [
  // Basic constraints (not supported by Gemini API)
  "minLength", "maxLength", "exclusiveMinimum", "exclusiveMaximum",
  "minItems", "maxItems", "format",
  // String/array constraints Gemini rejects (wave8)
  "pattern", "uniqueItems",
  // Array keyword with no Gemini field; agent tool schemas set it routinely
  "contains",
  // 2020-12 keywords with no Gemini equivalent
  "unevaluatedProperties", "unevaluatedItems", "contentSchema",
  // Tuple-array keywords; converted to items first, leftovers stripped
  "prefixItems", "additionalItems",
  // Numeric constraints Gemini rejects (Switchboard#2309)
  "multipleOf", "minimum", "maximum",
  // Claude rejects these in VALIDATED mode
  "default", "examples",
  // JSON Schema meta keywords
  "$schema", "$defs", "definitions", "const", "$ref", "$comment", "ref",
  // Annotation keywords (rejected by Gemini/Antigravity - e.g. MCP tool schemas set these)
  "deprecated", "readOnly", "writeOnly",
  // Object validation keywords (not supported)
  "additionalProperties", "propertyNames", "patternProperties", "enumDescriptions",
  // Complex schema keywords (handled by flattenAnyOfOneOf/mergeAllOf)
  "anyOf", "oneOf", "allOf", "not",
  // Dependency keywords (not supported)
  "dependencies", "dependentSchemas", "dependentRequired",
  // Other unsupported keywords
  "title", "optional", "deprecated", "if", "then", "else", "contentMediaType", "contentEncoding",
  // UI/Styling properties (from Cursor tools - NOT JSON Schema standard)
  "cornerRadius", "fillColor", "fontFamily", "fontSize", "fontWeight",
  "gap", "padding", "strokeColor", "strokeThickness", "textColor",
  // Non-standard annotation/error keywords used by some MCP tool schemas (#4283).
  // Gemini's schema proto has no field for these and rejects the whole request with
  // "Unknown name X: Cannot find field" if any nested schema node carries them.
  "errorMessage", "errorMessages", "x-errorMessage", "x-errorMessages",
  "markdownDescription", "x-intellij-html-description",
  "x-taplo-info", "x-taplo", "doNotSuggest", "suggestSortText",
  "minProperties", "maxProperties"
];

// Default safety settings
export const DEFAULT_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" }
];

// Convert OpenAI content to Gemini parts
export function convertOpenAIContentToParts(content) {
  const parts = [];

  if (typeof content === "string") {
    parts.push({ text: content });
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== "object") continue; // null entries crash (wave15)
      if (item.type === OPENAI_BLOCK.TEXT) {
        parts.push({ text: item.text });
      } else if (item.type === OPENAI_BLOCK.IMAGE_URL && item.image_url?.url?.startsWith("data:")) {
        const url = item.image_url.url;
        const commaIndex = url.indexOf(",");
        if (commaIndex !== -1) {
          const mimePart = url.substring(5, commaIndex); // skip "data:"
          const data = url.substring(commaIndex + 1);
          const mimeType = mimePart.split(";")[0];

          parts.push({
            inlineData: { mime_type: mimeType, data: data }
          });
        }
      } else if (item.type === OPENAI_BLOCK.IMAGE_URL && item.image_url?.url && (item.image_url.url.startsWith("http://") || item.image_url.url.startsWith("https://"))) {
        parts.push({
          fileData: { fileUri: item.image_url.url, mimeType: "image/*" }
        });
      } else if (item.type === OPENAI_BLOCK.INPUT_AUDIO && item.input_audio?.data) {
        const format = item.input_audio.format || "wav";
        const mimeType = format === "mp3" ? "audio/mpeg" : `audio/${format}`;
        parts.push({
          inlineData: { mime_type: mimeType, data: item.input_audio.data }
        });
      } else if (item.type === OPENAI_BLOCK.AUDIO_URL && item.audio_url?.url?.startsWith("data:")) {
        const url = item.audio_url.url;
        const commaIndex = url.indexOf(",");
        if (commaIndex !== -1) {
          const mimePart = url.substring(5, commaIndex);
          const data = url.substring(commaIndex + 1);
          const mimeType = mimePart.split(";")[0];
          parts.push({
            inlineData: { mime_type: mimeType, data: data }
          });
        }
      } else if (item.type === OPENAI_BLOCK.FILE) {
        const fileData = item.file?.file_data;
        if (typeof fileData === "string" && fileData.startsWith("data:")) {
          const commaIndex = fileData.indexOf(",");
          if (commaIndex !== -1) {
            const mimeType = fileData.substring(5, commaIndex).split(";")[0];
            const data = fileData.substring(commaIndex + 1);
            parts.push({ inlineData: { mime_type: mimeType, data: data } });
          }
        } else if (item.file?.file_id) {
          // File reference without inline bytes — carry as a URI part, never drop.
          parts.push({ fileData: { fileUri: item.file.file_id } });
        } else if (typeof fileData === "string" && fileData) {
          parts.push({ text: `[File: ${fileData}]` });
        }
      } else if (item.type === OPENAI_BLOCK.IMAGE && item.source) {
        // Claude-bridge image block: { source: { type: base64|url, ... } }.
        if (item.source.type === "base64" && item.source.data) {
          parts.push({
            inlineData: { mime_type: item.source.media_type || "image/png", data: item.source.data }
          });
        } else if (item.source.type === "url" && item.source.url) {
          parts.push({ fileData: { fileUri: item.source.url, mimeType: "image/*" } });
        }
      }
    }
  }

  return parts;
}

// Extract text content from OpenAI content
export function extractTextContent(content, separator = "") {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter(c => c.type === OPENAI_BLOCK.TEXT).map(c => c.text).join(separator);
  }
  return "";
}

// Try parse JSON safely (null fallback on parse error; re-export keeps legacy API)
export function tryParseJSON(str) {
  return safeParseJSON(str, null);
}

// Generate request ID
export function generateRequestId() {
  return `agent-${crypto.randomUUID()}`;
}

// Generate session ID (binary-compatible format: UUID + timestamp)
export function generateSessionId() {
  return crypto.randomUUID() + Date.now().toString();
}

// Generate project ID
export function generateProjectId() {
  const adjectives = ["useful", "bright", "swift", "calm", "bold"];
  const nouns = ["fuze", "wave", "spark", "flow", "core"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj}-${noun}-${crypto.randomUUID().slice(0, 5)}`;
}

// Helper: Remove unsupported keywords recursively from object/array
// Also strips all vendor extension fields (x- prefixed) not supported by Gemini
function removeUnsupportedKeywords(obj, keywords) {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      removeUnsupportedKeywords(item, keywords);
    }
    return;
  }

  for (const key of Object.keys(obj)) {
    if (keywords.includes(key) || key.startsWith("x-")) {
      delete obj[key];
      continue;
    }

    const value = obj[key];
    if (value && typeof value === "object") {
      removeUnsupportedKeywords(value, keywords);
    }
  }
}

// Convert const to enum
function convertConstToEnum(obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.const !== undefined && !obj.enum) {
    obj.enum = [obj.const];
    delete obj.const;
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      convertConstToEnum(value);
    }
  }
}

// Convert enum values to strings (Gemini requires string enum values + explicit type:"string")
function convertEnumValuesToStrings(obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.enum && Array.isArray(obj.enum)) {
    obj.enum = obj.enum.map(v => String(v));
    // Gemini API only accepts enum on type:"string". Leaving a declared
    // type:"integer"/"number" beside the now-stringified values returns 400.
    obj.type = "string";
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      convertEnumValuesToStrings(value);
    }
  }
}

// Merge allOf schemas
function mergeAllOf(obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.allOf && Array.isArray(obj.allOf)) {
    const merged = {};
    const rest = {};

    for (const item of obj.allOf) {
      if (!item || typeof item !== "object") continue;
      if (item.properties) {
        if (!merged.properties) merged.properties = {};
        Object.assign(merged.properties, item.properties);
      }
      if (item.required && Array.isArray(item.required)) {
        if (!merged.required) merged.required = [];
        for (const req of item.required) {
          if (!merged.required.includes(req)) {
            merged.required.push(req);
          }
        }
      }
      // A `$ref` to a plain enum/scalar expands to an allOf item whose whole
      // definition is `type`/`enum`/`items`/… — dropping those left the caller
      // with an untyped property and a lost enum.
      for (const [k, v] of Object.entries(item)) {
        if (k === "properties" || k === "required") continue;
        if (!(k in rest)) rest[k] = v;
      }
    }

    delete obj.allOf;
    for (const [k, v] of Object.entries(rest)) {
      if (!(k in obj)) obj[k] = v; // explicit keys on the parent win
    }
    if (merged.properties) obj.properties = { ...obj.properties, ...merged.properties };
    if (merged.required) obj.required = [...(obj.required || []), ...merged.required];
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      mergeAllOf(value);
    }
  }
}

// Select best schema from anyOf/oneOf
function selectBest(items) {
  let bestIdx = 0;
  let bestScore = -1;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let score = 0;
    const type = item.type;

    if (type === "object" || item.properties) {
      score = 3;
    } else if (type === "array" || item.items) {
      score = 2;
    } else if (type && type !== "null") {
      score = 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestIdx;
}

// Flatten anyOf/oneOf
function flattenAnyOfOneOf(obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.anyOf && Array.isArray(obj.anyOf) && obj.anyOf.length > 0) {
    const nonNullSchemas = obj.anyOf.filter(s => s && s.type !== "null");
    if (nonNullSchemas.length > 0) {
      const bestIdx = selectBest(nonNullSchemas);
      const selected = nonNullSchemas[bestIdx];
      delete obj.anyOf;
      Object.assign(obj, selected);
    }
  }

  if (obj.oneOf && Array.isArray(obj.oneOf) && obj.oneOf.length > 0) {
    const nonNullSchemas = obj.oneOf.filter(s => s && s.type !== "null");
    if (nonNullSchemas.length > 0) {
      const bestIdx = selectBest(nonNullSchemas);
      const selected = nonNullSchemas[bestIdx];
      delete obj.oneOf;
      Object.assign(obj, selected);
    }
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      flattenAnyOfOneOf(value);
    }
  }
}

// Flatten type arrays
function flattenTypeArrays(obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.type && Array.isArray(obj.type)) {
    const nonNullTypes = obj.type.filter(t => t !== "null");
    if (nonNullTypes.length <= 1) {
      obj.type = nonNullTypes[0] || "string";
    } else if (obj.properties && nonNullTypes.includes("object")) {
      // Several types: prefer the one the schema's structure describes, then
      // the most permissive scalar (string), then number/integer/boolean.
      obj.type = "object";
    } else if (obj.items?.type && nonNullTypes.includes("array")) {
      obj.type = "array";
    } else {
      obj.type = ["string", "number", "integer", "boolean"].find(t => nonNullTypes.includes(t)) || nonNullTypes[0];
    }
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      flattenTypeArrays(value);
    }
  }
}

// Infer missing type=object when properties exist (Gemini requires explicit type)
function ensureObjectType(obj) {
  if (!obj || typeof obj !== "object") return;
  if (obj.properties && !obj.type) obj.type = "object";
  for (const [key, v] of Object.entries(obj)) {
    if (!v || typeof v !== "object") continue;
    if (key === "properties" && !Array.isArray(v)) {
      for (const sub of Object.values(v)) ensureObjectType(sub);
    } else {
      ensureObjectType(v);
    }
  }
}

// Recurse into child schemas; a `properties` map holds schemas keyed by
// parameter name, so its own keys (a param named "type"/"items") are not schema keywords.
function forEachChildSchema(obj, fn) {
  for (const [key, v] of Object.entries(obj)) {
    if (!v || typeof v !== "object") continue;
    if (key === "properties" && !Array.isArray(v)) {
      for (const sub of Object.values(v)) fn(sub);
    } else {
      fn(v);
    }
  }
}

// Convert prefixItems (tuple validation) to items — Gemini cannot express tuples,
// and a type:"array" schema without items is rejected with "missing field".
function convertPrefixItems(obj) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj.prefixItems) && obj.prefixItems.length > 0) {
    const variants = obj.prefixItems.filter(s => s && s.type !== "null");
    if (!obj.items && variants.length === 1) {
      obj.items = variants[0];
    } else if (!obj.items && variants.length > 1) {
      obj.items = { anyOf: variants };
    }
    delete obj.prefixItems;
  }
  forEachChildSchema(obj, convertPrefixItems);
}

// Gemini requires typed items on every type:"array" schema — fill a permissive placeholder.
function fixArrayItems(obj) {
  if (!obj.items || typeof obj.items !== "object" || Array.isArray(obj.items) || Object.keys(obj.items).length === 0) {
    obj.items = { type: "string" };
  } else if (!obj.items.type) {
    obj.items.type = obj.items.properties ? "object" : obj.items.items ? "array" : "string";
  }
}

function ensureArrayItems(obj) {
  if (!obj || typeof obj !== "object") return;
  if (obj.type === "array") fixArrayItems(obj);
  forEachChildSchema(obj, ensureArrayItems);
}

// Gemini Schema proto predicates: `items` only on type array; `properties` /
// `required` only on type object. Recursion skips a properties map's own keys,
// so params named items/properties/required are never mistaken for keywords.
function enforceTypeConstraints(obj) {
  if (!obj || typeof obj !== "object") return;
  forEachChildSchema(obj, enforceTypeConstraints);
  if (Array.isArray(obj)) return;
  if (obj.type === "array") fixArrayItems(obj);
  else delete obj.items;
  if (obj.type !== "object") {
    delete obj.properties;
    delete obj.required;
  }
}

// Clean JSON Schema for Antigravity API compatibility - removes unsupported keywords recursively
export function cleanJSONSchemaForAntigravity(schema) {
  if (!schema || typeof schema !== "object") return schema;

  // Mutate directly (schema is only used once per request)
  let cleaned = schema;

  // Phase 1: Convert and prepare
  convertConstToEnum(cleaned);

  // Phase 2: Flatten complex structures
  mergeAllOf(cleaned);
  convertPrefixItems(cleaned);
  flattenAnyOfOneOf(cleaned);
  flattenTypeArrays(cleaned);

  // Phase 2.1: Normalize enums *after* flattening, so enums lifted out of
  // allOf/anyOf branches are stringified and typed too.
  convertEnumValuesToStrings(cleaned);

  // Phase 2.5: Infer missing type=object when properties exist (Gemini requirement)
  ensureObjectType(cleaned);
  ensureArrayItems(cleaned);

  // Phase 2.7: Convert invalid property values (e.g. property: "object") to proper schemas.
  // Claude Code tools sometimes have properties like { "field": "object" } where the value
  // is a plain JSON Schema type string instead of a schema object. Gemini/Vertex rejects these.
  // Switchboard PR#1600 / #1564.
  function fixInvalidPropertyValues(obj) {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) { obj.forEach(fixInvalidPropertyValues); return; }
    if (obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties)) {
      for (const [key, val] of Object.entries(obj.properties)) {
        if (typeof val === "string") {
          const t = val.toLowerCase();
          if (t === "object") obj.properties[key] = { type: "object", properties: {} };
          else if (["string", "number", "integer", "boolean", "array"].includes(t)) obj.properties[key] = { type: t };
          else obj.properties[key] = { type: "string", description: val };
        } else if (val !== null && typeof val === "object") {
          fixInvalidPropertyValues(val);
        }
      }
    }
    for (const [key, val] of Object.entries(obj)) {
      if (key !== "properties" && val && typeof val === "object") fixInvalidPropertyValues(val);
    }
  }
  fixInvalidPropertyValues(cleaned);

  // Phase 3: Remove all unsupported keywords at ALL levels (including inside arrays)
  removeUnsupportedKeywords(cleaned, UNSUPPORTED_SCHEMA_CONSTRAINTS);

  // Phase 4: Cleanup required fields recursively
  function cleanupRequired(obj) {
    if (!obj || typeof obj !== "object") return;

    if (obj.required && Array.isArray(obj.required) && obj.properties) {
      const validRequired = obj.required.filter(field =>
        Object.prototype.hasOwnProperty.call(obj.properties, field)
      );
      if (validRequired.length === 0) {
        delete obj.required;
      } else {
        obj.required = validRequired;
      }
    }

    // Recurse into nested objects
    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") {
        cleanupRequired(value);
      }
    }
  }

  cleanupRequired(cleaned);

  // Phase 5: Add placeholder for empty object schemas (Antigravity requirement)
  function addPlaceholders(obj) {
    if (!obj || typeof obj !== "object") return;

    if (obj.type === "object") {
      if (!obj.properties || Object.keys(obj.properties).length === 0) {
        obj.properties = {
          reason: {
            type: "string",
            description: "Brief explanation of why you are calling this tool"
          }
        };
        obj.required = ["reason"];
      }
    }

    // Recurse into nested objects
    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") {
        addPlaceholders(value);
      }
    }
  }

  addPlaceholders(cleaned);

  // Phase 6: Enforce Gemini protobuf type predicates on items/properties/required
  enforceTypeConstraints(cleaned);

  return cleaned;
}

// Gemini / Cloud Code treat a `$ref` key inside functionResponse.response as a
// pointer to functionResponse.parts and reject the request with 400
// INVALID_ARGUMENT ("The referenced name ... does not match to a display_name").
// Tool results carrying JSON Schema / OpenAPI documents (webfetch, read, MCP)
// hit this, so rename the key.
export const GEMINI_RESERVED_RESPONSE_KEYS = { "$ref": "_ref" };

// Recursively rename reserved keys in a tool-result payload (arrays/objects only)
export function sanitizeFunctionResponsePayload(value) {
  if (Array.isArray(value)) return value.map(sanitizeFunctionResponsePayload);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[GEMINI_RESERVED_RESPONSE_KEYS[key] ?? key] = sanitizeFunctionResponsePayload(val);
  }
  return out;
}

function sanitizeFunctionResponsePart(part) {
  const response = part?.functionResponse?.response;
  if (!response || typeof response !== "object") return part;
  return { ...part, functionResponse: { ...part.functionResponse, response: sanitizeFunctionResponsePayload(response) } };
}

// Gemini 4 rejects a merged user turn whose last part is not a functionResponse (#4802)
function moveFunctionResponsesLast(parts) {
  const responses = parts.filter(p => p.functionResponse);
  if (!responses.length) return parts;
  return [...parts.filter(p => !p.functionResponse), ...responses];
}

// Merge adjacent same-role turns, strip empty parts, and guarantee the
// conversation opens and closes on a user turn (Gemini rejects a leading
// model turn, and a trailing model turn is assistant prefill; a trailing
// unanswered functionCall gets a stub functionResponse instead).
export function normalizeGeminiContents(contents, model = null) {
  const frLast = isGemini4Model(model);
  const out = [];
  for (const c of contents || []) {
    if (!c?.role || !Array.isArray(c.parts)) continue;
    const parts = c.parts.filter(p => p && Object.keys(p).length > 0).map(sanitizeFunctionResponsePart);
    if (parts.length === 0) continue;
    const last = out.at(-1);
    if (last?.role === c.role) {
      last.parts.push(...parts);
      if (frLast) last.parts = moveFunctionResponsesLast(last.parts);
    } else out.push({ ...c, parts: [...parts] });
  }
  if (out.length > 0 && out[0].role !== "user") {
    out.unshift({ role: "user", parts: [{ text: "..." }] });
  }
  if (out.length > 0 && out.at(-1).role === "model") {
    const fnCalls = out.at(-1).parts.filter(p => p?.functionCall);
    if (fnCalls.length > 0) {
      out.push({
        role: "user",
        parts: fnCalls.map(p => {
          const call = p.functionCall || {};
          const fr = { name: call.name || "tool", response: { result: "Continue." } };
          if (call.id) fr.id = call.id;
          return { functionResponse: fr };
        }),
      });
    } else {
      out.push({ role: "user", parts: [{ text: "Continue." }] });
    }
  }
  return out;
}
