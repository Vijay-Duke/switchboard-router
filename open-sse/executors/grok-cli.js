import crypto from "node:crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import grokCliProvider from "../providers/registry/grok-cli.js";
import {
  refreshProviderCredentials,
  shouldRefreshCredentials,
} from "../services/oauthCredentialManager.js";
import { normalizeResponsesInput } from "../translator/formats/responsesApi.js";
import { getModelUpstreamId } from "../config/providerModels.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { getConsistentMachineId } from "../shared/machineId.js";
import { executeWithPreOutputSseRetry } from "../utils/sseTransientRetry.js";
import {
  GROK_CLI_BASE_URL,
  GROK_CLI_IDENTITY,
  GROK_CLI_MODEL,
  supportsGrokCliReasoningEffort,
} from "../config/grokCli.js";

const ALLOWED_FIELDS = new Set([
  "model", "input", "instructions", "tools", "tool_choice", "stream", "store",
  "reasoning", "include", "temperature", "top_p", "max_output_tokens",
  "parallel_tool_calls", "text", "metadata", "prompt_cache_key",
]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const NATIVE_ITEM_ID = /^(?:rs|msg|fc)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function countUserTurns(input) {
  if (!Array.isArray(input)) return 1;
  return Math.max(1, input.filter((item) => item?.role === "user" && (!item.type || item.type === "message")).length);
}

function normalizeEffort(value) {
  const effort = String(value || "").trim().toLowerCase();
  if (effort === "max") return "xhigh";
  return EFFORTS.has(effort) ? effort : "high";
}

function normalizeTools(body) {
  if (!Array.isArray(body.tools) || body.tools.length === 0) {
    delete body.tools;
    delete body.tool_choice;
    return;
  }
  const names = new Set();
  body.tools = body.tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return [];
    if (["web_search", "x_search", "file_search", "image_generation", "code_interpreter", "mcp", "local_shell"].includes(tool.type)) {
      return [tool];
    }
    const fn = tool.function && typeof tool.function === "object" ? tool.function : tool;
    const name = typeof fn.name === "string" ? fn.name.trim().slice(0, 128) : "";
    if (!name) return [];
    names.add(name);
    return [{
      type: "function",
      name,
      ...(fn.description ? { description: String(fn.description) } : {}),
      parameters: tool.type === "custom"
        ? { type: "object", properties: { input: { type: "string" } }, required: ["input"] }
        : (fn.parameters || { type: "object", properties: {} }),
    }];
  });
  if (body.tools.length === 0) {
    delete body.tools;
    delete body.tool_choice;
  } else if (body.tool_choice && typeof body.tool_choice === "object") {
    const name = body.tool_choice.name || body.tool_choice.function?.name;
    if (names.has(name)) body.tool_choice = { type: "function", name };
    else delete body.tool_choice;
  }
}

function stripStoredReferences(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (typeof item === "string") return !/^(rs|fc|resp|msg)_/.test(item);
    if (!item || typeof item !== "object") return true;
    if (item.type === "item_reference") return false;
    if (typeof item.id === "string" && /^(rs|fc|resp|msg)_/.test(item.id) && !NATIVE_ITEM_ID.test(item.id)) {
      delete item.id;
    }
    return true;
  });
}

function requestMetadata(credentials, body) {
  if (credentials._grokCliRequest) return credentials._grokCliRequest;
  credentials._grokCliRequest = {
    sessionId: resolveSessionId({
      headers: credentials.rawHeaders,
      body,
      connectionId: credentials.connectionId || credentials.id,
      workspaceId: credentials.providerSpecificData?.workspaceId,
      scope: "grok-cli",
    }),
    requestId: crypto.randomUUID(),
    agentId: credentials.providerSpecificData?.deviceId || null,
    turnIdx: 1,
    model: null,
  };
  return credentials._grokCliRequest;
}

function formatAgentId(machineId) {
  const hex = `${machineId}${machineId}`.replace(/[^0-9a-f]/gi, "0").padEnd(32, "0").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export class GrokCliExecutor extends BaseExecutor {
  constructor() {
    super("grok-cli", PROVIDERS["grok-cli"] || grokCliProvider.transport);
  }

  buildUrl() {
    return `${GROK_CLI_BASE_URL}/responses`;
  }

  resolveIdentity() {
    return GROK_CLI_IDENTITY;
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials?.refreshToken) return null;
    return refreshProviderCredentials("grok-cli", credentials, log, proxyOptions);
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials("grok-cli", credentials);
  }

  buildHeaders(credentials, stream = true) {
    const headers = super.buildHeaders(credentials, stream);
    const meta = requestMetadata(credentials, {});
    headers["x-grok-session-id"] = meta.sessionId;
    headers["x-grok-conv-id"] = meta.sessionId;
    headers["x-grok-req-id"] = meta.requestId;
    headers["x-grok-turn-idx"] = String(meta.turnIdx);
    if (meta.agentId) headers["x-grok-agent-id"] = meta.agentId;
    if (meta.model) headers["x-grok-model-override"] = meta.model;
    const psd = credentials.providerSpecificData || {};
    if (psd.email || credentials.email) headers["x-email"] = psd.email || credentials.email;
    if (psd.userId || credentials.userId) headers["x-userid"] = psd.userId || credentials.userId;
    return headers;
  }

  transformRequest(model, body, stream, credentials) {
    const meta = requestMetadata(credentials, body);
    const input = normalizeResponsesInput(body.input);
    if (input) body.input = input;
    else if (Array.isArray(body.messages)) {
      body.input = body.messages.map((message) => ({
        type: "message",
        role: message.role || "user",
        content: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
      }));
    }
    if (!body.input) body.input = normalizeResponsesInput("");

    stripStoredReferences(body);
    normalizeTools(body);
    meta.turnIdx = countUserTurns(body.input);

    const requested = String(body.model || model || GROK_CLI_MODEL);
    const suffix = requested.match(/-(low|medium|high|xhigh)$/)?.[1] || null;
    const baseModel = suffix ? requested.slice(0, -(suffix.length + 1)) : requested;
    body.model = getModelUpstreamId("gcli", baseModel) || baseModel;
    meta.model = body.model;

    const existingReasoning = body.reasoning && typeof body.reasoning === "object" ? body.reasoning : {};
    body.reasoning = { ...existingReasoning, summary: existingReasoning.summary || "concise" };
    if (supportsGrokCliReasoningEffort(body.model)) {
      body.reasoning.effort = normalizeEffort(existingReasoning.effort || body.reasoning_effort || suffix);
    } else {
      delete body.reasoning.effort;
    }
    delete body.reasoning_effort;
    body.include = Array.isArray(body.include) ? body.include : [];
    if (!body.include.includes("reasoning.encrypted_content")) body.include.push("reasoning.encrypted_content");
    body.stream = true;
    body.store = false;

    delete body.messages;
    delete body.max_tokens;
    delete body.max_completion_tokens;
    delete body.user;
    delete body.stream_options;
    delete body.previous_response_id;
    for (const key of Object.keys(body)) if (!ALLOWED_FIELDS.has(key)) delete body[key];
    return body;
  }

  async execute(args) {
    const credentials = { ...(args.credentials || {}) };
    const meta = requestMetadata(credentials, args.body);
    if (!meta.agentId) meta.agentId = formatAgentId(await getConsistentMachineId("grok-cli-agent"));
    return executeWithPreOutputSseRetry({
      execute: () => super.execute({ ...args, credentials }),
      retryConfig: this.config.retry,
      signal: args.signal,
      log: args.log,
      provider: "grok-cli",
    });
  }

  parseError(response, bodyText) {
    if (response.status === 402 && bodyText) {
      try {
        const data = JSON.parse(bodyText);
        return { status: 402, message: data.error || data.message || bodyText, code: data.code };
      } catch { /* fall through */ }
    }
    return super.parseError(response, bodyText);
  }
}

export default GrokCliExecutor;
