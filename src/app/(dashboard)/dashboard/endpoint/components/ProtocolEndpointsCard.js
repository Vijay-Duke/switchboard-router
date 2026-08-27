"use client";
// @ts-check

import { useState } from "react";
import PropTypes from "prop-types";
import { Card, Input, SegmentedControl } from "@/shared/components";

/**
 * @typedef {object} ProtocolEndpoint
 * @property {string} id
 * @property {string} label
 * @property {"openai"|"claude"|"gemini"|"responses"|"media"} category
 * @property {"BASE"|"POST"|"GET"} method
 * @property {string} path
 * @property {string} desc
 * @property {string} [headerHint]
 */

/** @type {ProtocolEndpoint[]} */
const ENDPOINTS = [
  {
    id: "openai_base",
    label: "OpenAI Base URL",
    category: "openai",
    method: "BASE",
    path: "/v1",
    desc: "For OPENAI_BASE_URL, Cursor, Aider, OpenCode, LiteLLM, LangChain",
    headerHint: "Authorization: Bearer <key>",
  },
  {
    id: "openai_chat",
    label: "Chat Completions",
    category: "openai",
    method: "POST",
    path: "/v1/chat/completions",
    desc: "Standard OpenAI chat stream & JSON format across all models & combos",
    headerHint: "Authorization: Bearer <key>",
  },
  {
    id: "openai_models",
    label: "Model Catalog",
    category: "openai",
    method: "GET",
    path: "/v1/models",
    desc: "Discover all active upstream models, custom models, and combos",
    headerHint: "Authorization: Bearer <key>",
  },
  {
    id: "claude_base",
    label: "Anthropic Base URL",
    category: "claude",
    method: "BASE",
    path: "",
    desc: "For ANTHROPIC_BASE_URL (Claude Code CLI, Cline, Roo Code, Claude SDK)",
    headerHint: "x-api-key: <key> or ANTHROPIC_AUTH_TOKEN",
  },
  {
    id: "claude_messages",
    label: "Claude Messages",
    category: "claude",
    method: "POST",
    path: "/v1/messages",
    desc: "Native Anthropic Messages API with streaming, tool use, & thinking blocks",
    headerHint: "x-api-key: <key> or Authorization: Bearer <key>",
  },
  {
    id: "claude_count",
    label: "Count Tokens",
    category: "claude",
    method: "POST",
    path: "/v1/messages/count_tokens",
    desc: "Anthropic token calculation API",
    headerHint: "x-api-key: <key>",
  },
  {
    id: "gemini_base",
    label: "Gemini Base URL",
    category: "gemini",
    method: "BASE",
    path: "/v1beta",
    desc: "For Google GenAI SDK & Gemini CLI base URLs",
    headerHint: "x-goog-api-key: <key>",
  },
  {
    id: "gemini_content",
    label: "Gemini Content Generation",
    category: "gemini",
    method: "POST",
    path: "/v1beta/models/{model}:generateContent",
    desc: "Native Google Gemini REST format with streaming & schema support",
    headerHint: "x-goog-api-key: <key>",
  },
  {
    id: "responses_api",
    label: "Codex Responses API",
    category: "responses",
    method: "POST",
    path: "/v1/responses",
    desc: "OpenAI Responses format (Codex CLI, instruction tuning, response loops)",
    headerHint: "Authorization: Bearer <key>",
  },
  {
    id: "media_stt",
    label: "Audio Transcriptions (STT)",
    category: "media",
    method: "POST",
    path: "/v1/audio/transcriptions",
    desc: "Speech-to-text audio transcription via multipart/form-data",
    headerHint: "Authorization: Bearer <key>",
  },
  {
    id: "media_tts",
    label: "Text-to-Speech (TTS)",
    category: "media",
    method: "POST",
    path: "/v1/audio/speech",
    desc: "Synthesize spoken audio from text with voice selection",
    headerHint: "Authorization: Bearer <key>",
  },
  {
    id: "media_embeddings",
    label: "Vector Embeddings",
    category: "media",
    method: "POST",
    path: "/v1/embeddings",
    desc: "Text embeddings for semantic search, vector stores, and RAG",
    headerHint: "Authorization: Bearer <key>",
  },
  {
    id: "media_images",
    label: "Image Generation",
    category: "media",
    method: "POST",
    path: "/v1/images/generations",
    desc: "Text-to-image synthesis and image editing",
    headerHint: "Authorization: Bearer <key>",
  },
];

const CATEGORY_OPTIONS = [
  { value: "all", label: "All Routes" },
  { value: "openai", label: "OpenAI", icon: "forum" },
  { value: "claude", label: "Claude", icon: "smart_toy" },
  { value: "gemini", label: "Gemini", icon: "diamond" },
  { value: "responses", label: "Responses", icon: "terminal" },
  { value: "media", label: "Media (STT/TTS/Img)", icon: "mic" },
  { value: "snippets", label: "SDK & CLI Snippets", icon: "code" },
];

/**
 * Method badge color mapping
 * @param {string} method
 */
function getMethodBadgeClass(method) {
  switch (method) {
    case "POST":
      return "bg-teal-500/10 text-teal-600 dark:text-teal-400 border-teal-500/20";
    case "GET":
      return "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20";
    case "BASE":
    default:
      return "bg-primary/10 text-primary border-primary/25";
  }
}

/**
 * Protocol & Tool Endpoints reference panel
 * @param {{
 *   origin: string,
 *   copied: string|null,
 *   onCopy: (text: string, id: string) => void
 * }} props
 */
export default function ProtocolEndpointsCard({ origin, copied, onCopy }) {
  const [selectedCategory, setSelectedCategory] = useState("all");

  const normalizedOrigin = origin.replace(/\/+$/, "");

  const filteredEndpoints = selectedCategory === "all"
    ? ENDPOINTS
    : ENDPOINTS.filter((e) => e.category === selectedCategory);

  const claudeSnippet = `export ANTHROPIC_BASE_URL="${normalizedOrigin}"
export ANTHROPIC_AUTH_TOKEN="sk_switchboard"
claude`;

  const pythonSnippet = `from openai import OpenAI

client = OpenAI(
    base_url="${normalizedOrigin}/v1",
    api_key="sk_switchboard"
)`;

  const curlSnippet = `curl ${normalizedOrigin}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer sk_switchboard" \\
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`;

  return (
    <Card>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">hub</span>
            Protocol & Tool Endpoints
          </h2>
          <p className="text-sm text-text-muted mt-1">
            Every route and protocol exposed by Switchboard with format translation.
          </p>
        </div>
      </div>

      <div className="mb-6 overflow-x-auto pb-1">
        <SegmentedControl
          options={CATEGORY_OPTIONS}
          value={selectedCategory}
          onChange={setSelectedCategory}
          size="sm"
        />
      </div>

      {selectedCategory === "snippets" ? (
        <div className="flex flex-col gap-6">
          {/* Claude Code CLI */}
          <div className="rounded-[10px] bg-surface-2 p-4 border border-border">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-[18px]">terminal</span>
                Claude Code CLI Environment
              </span>
              <button
                type="button"
                onClick={() => onCopy(claudeSnippet, "snippet_claude")}
                className="p-1.5 hover:bg-surface rounded text-text-muted hover:text-primary transition-colors text-xs flex items-center gap-1 border border-border/50"
              >
                <span className="material-symbols-outlined text-[16px]">
                  {copied === "snippet_claude" ? "check" : "content_copy"}
                </span>
                {copied === "snippet_claude" ? "Copied" : "Copy"}
              </button>
            </div>
            <pre className="text-xs font-mono bg-black/5 dark:bg-black/40 p-3 rounded-[6px] overflow-x-auto text-text-main">
              {claudeSnippet}
            </pre>
          </div>

          {/* Python OpenAI SDK */}
          <div className="rounded-[10px] bg-surface-2 p-4 border border-border">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-[18px]">code</span>
                OpenAI Python SDK
              </span>
              <button
                type="button"
                onClick={() => onCopy(pythonSnippet, "snippet_python")}
                className="p-1.5 hover:bg-surface rounded text-text-muted hover:text-primary transition-colors text-xs flex items-center gap-1 border border-border/50"
              >
                <span className="material-symbols-outlined text-[16px]">
                  {copied === "snippet_python" ? "check" : "content_copy"}
                </span>
                {copied === "snippet_python" ? "Copied" : "Copy"}
              </button>
            </div>
            <pre className="text-xs font-mono bg-black/5 dark:bg-black/40 p-3 rounded-[6px] overflow-x-auto text-text-main">
              {pythonSnippet}
            </pre>
          </div>

          {/* cURL */}
          <div className="rounded-[10px] bg-surface-2 p-4 border border-border">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-[18px]">send</span>
                Direct cURL
              </span>
              <button
                type="button"
                onClick={() => onCopy(curlSnippet, "snippet_curl")}
                className="p-1.5 hover:bg-surface rounded text-text-muted hover:text-primary transition-colors text-xs flex items-center gap-1 border border-border/50"
              >
                <span className="material-symbols-outlined text-[16px]">
                  {copied === "snippet_curl" ? "check" : "content_copy"}
                </span>
                {copied === "snippet_curl" ? "Copied" : "Copy"}
              </button>
            </div>
            <pre className="text-xs font-mono bg-black/5 dark:bg-black/40 p-3 rounded-[6px] overflow-x-auto text-text-main">
              {curlSnippet}
            </pre>
          </div>
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-border/60">
          {filteredEndpoints.map((item) => {
            const url = `${normalizedOrigin}${item.path}`;
            return (
              <div key={item.id} className="py-3.5 first:pt-0 last:pb-0 flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`text-[11px] font-mono font-semibold px-2 py-0.5 rounded border shrink-0 ${getMethodBadgeClass(
                        item.method
                      )}`}
                    >
                      {item.method}
                    </span>
                    <span className="text-sm font-medium truncate">{item.label}</span>
                  </div>
                  {item.headerHint && (
                    <span className="text-[11px] font-mono text-text-muted hidden md:inline truncate max-w-[280px]">
                      {item.headerHint}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 min-w-0">
                  <Input
                    value={url}
                    readOnly
                    className="flex-1 min-w-0"
                    inputClassName="font-mono text-xs bg-surface-2"
                  />
                  <button
                    type="button"
                    onClick={() => onCopy(url, item.id)}
                    className="p-2 hover:bg-surface-2 rounded text-text-muted hover:text-primary transition-colors shrink-0 border border-transparent hover:border-border"
                    title="Copy URL"
                    aria-label={`Copy ${item.label} URL`}
                  >
                    <span className="material-symbols-outlined text-[18px] leading-none">
                      {copied === item.id ? "check" : "content_copy"}
                    </span>
                  </button>
                </div>

                <p className="text-xs text-text-muted">{item.desc}</p>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

ProtocolEndpointsCard.propTypes = {
  origin: PropTypes.string.isRequired,
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
};
