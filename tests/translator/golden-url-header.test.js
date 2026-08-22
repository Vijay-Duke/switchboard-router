// P0 GOLDEN: lock buildUrl + buildHeaders cho mọi provider trên code CŨ.
// Sinh snapshot lần đầu (baseline) → sau refactor chạy lại phải khớp y hệt.
// Mock proxyFetch + uuid-heavy executors KHÔNG cần ở đây vì chỉ gọi buildUrl/buildHeaders (pure).
import { describe, it, expect } from "vitest";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { wrapHeaders } from "../../open-sse/identity/wrap.js";

// Credentials mẫu cố định (deterministic) — KHÔNG dùng Date.now/random.
const API_KEY_CRED = { apiKey: "sk-test-APIKEY", providerSpecificData: {} };
const OAUTH_CRED = { accessToken: "tok-test-ACCESS", providerSpecificData: {} };
const SPECIAL_CRED = {
  apiKey: "sk-test-APIKEY",
  accessToken: "tok-test-ACCESS",
  providerSpecificData: { accountId: "ACC123", region: "sgp", baseUrl: "https://custom.example.com/v1", orgId: "ORG9" },
};

// Provider cần executor riêng (buildUrl/buildHeaders không nằm ở DefaultExecutor) → bỏ qua ở golden này.
// Chúng được lock riêng ở 11-provider edge tests / unit test chuyên biệt.
const SPECIALIZED = new Set([
  "antigravity", "azure", "gemini-cli", "github", "iflow", "qoder", "kiro",
  "codex", "cursor", "vertex", "vertex-partner", "qwen", "opencode",
  "opencode-go", "grok-web", "perplexity-web", "ollama-local", "commandcode",
  "xiaomi-tokenplan", "mimo-free",
]);

// Sanitize dynamic credentials, timestamps, host details, and live identity versions
// while retaining the product/profile shape asserted by the golden.
function sanitize(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/switchboard/i.test(k) || /switchboard/i.test(String(v))) {
      throw new Error(`Switchboard leak in header ${k}`);
    }
    const name = k.toLowerCase();
    if (name === "x-client-version" || name === "x-core-version") {
      out[k] = "<VERSION>";
      continue;
    }
    if (name === "x-platform-version" || name === "x-stainless-runtime-version") {
      out[k] = "<NODE_VERSION>";
      continue;
    }
    if (name === "x-stainless-package-version") {
      out[k] = "<PACKAGE_VERSION>";
      continue;
    }
    if (name === "x-platform" || name === "x-stainless-os") {
      out[k] = "<PLATFORM>";
      continue;
    }
    if (name === "x-stainless-arch") {
      out[k] = "<ARCH>";
      continue;
    }
    if (name === "x-msh-device-model") {
      out[k] = "<PLATFORM> <ARCH>";
      continue;
    }
    out[k] = typeof v === "string"
      ? v.replace(/Bearer .+/, "Bearer <TOK>")
          .replace(/sk-test-APIKEY|tok-test-ACCESS/g, "<CRED>")
          .replace(/(OpenAI\/NodeJS\/)v?\d+(?:\.\d+)+/gi, "$1<NODE_VERSION>")
          .replace(/(\b(?:claude-cli|codex_cli_rs|GeminiCLI|Cline|antigravity|GitHubCopilotChat|QwenCode|grok-cli)\/)\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?/gi, "$1<VERSION>")
          .replace(/kimi-\d{10,}/g, "kimi-<TS>")
      : v;
  }
  return out;
}

describe("sanitize headers", () => {
  it("rejects Switchboard in header names and values", () => {
    expect(() => sanitize({ "X-Switchboard-Test": "ok" })).toThrow(/switchboard/i);
    expect(() => sanitize({ "User-Agent": "Switchboard/1.2.3" })).toThrow(/switchboard/i);
  });
});

const providerIds = Object.keys(PROVIDERS).filter((p) => !SPECIALIZED.has(p)).sort();

function providerWireHeaders(ex, pid, credentials, stream) {
  return wrapHeaders(ex.buildHeaders(credentials, stream), {
    identity: PROVIDERS[pid].identity,
    provider: pid,
    format: PROVIDERS[pid].format,
    stream,
  }).headers;
}

describe("GOLDEN buildUrl (default executor providers)", () => {
  for (const pid of providerIds) {
    it(`${pid} → url (stream + non-stream)`, () => {
      const ex = new DefaultExecutor(pid);
      const cred = PROVIDERS[pid].noAuth ? {} : SPECIAL_CRED;
      const model = "test-model";
      const snap = {
        stream: safe(() => ex.buildUrl(model, true, 0, cred)),
        nonStream: safe(() => ex.buildUrl(model, false, 0, cred)),
      };
      expect(snap).toMatchSnapshot();
    });
  }
});

describe("GOLDEN buildHeaders (default executor providers)", () => {
  for (const pid of providerIds) {
    it(`${pid} → headers (apiKey / oauth)`, () => {
      const ex = new DefaultExecutor(pid);
      const snap = {
        apiKey: sanitize(providerWireHeaders(ex, pid, PROVIDERS[pid].noAuth ? {} : API_KEY_CRED, true)),
        oauth: sanitize(providerWireHeaders(ex, pid, PROVIDERS[pid].noAuth ? {} : OAUTH_CRED, true)),
        nonStream: sanitize(providerWireHeaders(ex, pid, PROVIDERS[pid].noAuth ? {} : API_KEY_CRED, false)),
      };
      expect(snap).toMatchSnapshot();
    });
  }
});

// P0 regression: host-dependent headers phải được sanitize → snapshot không phụ thuộc
// platform/arch của runner (CI Ubuntu vs local macOS). Assert trực tiếp placeholder
// để lock độc lập với snapshot file.
describe("GOLDEN buildHeaders — platform-independent sanitization", () => {
  // [providerId, headerKey] — mỗi entry là một header mang giá trị process.platform/arch.
  const HOST_DEPENDENT = [
    ["cline", "X-PLATFORM"],
    ["clinepass", "X-PLATFORM"],
    ["claude", "X-Stainless-Os"],
    ["claude", "X-Stainless-Arch"],
    ["kimi-coding", "X-Msh-Device-Model"],
  ];

  for (const [pid, key] of HOST_DEPENDENT) {
    it(`${pid}: ${key} normalized to placeholder (no raw darwin/linux/arm64/x64)`, () => {
      const ex = new DefaultExecutor(pid);
      const wrapped = providerWireHeaders(ex, pid, API_KEY_CRED, true);
      const clean = sanitize(wrapped);
      expect(wrapped[key]).toBeTruthy();           // wrapped header thực sự được emit
      expect(clean[key]).toMatch(/^<.+>$/);        // chỉ còn placeholder
      // Không rò rỉ giá trị host cụ thể sau sanitize.
      expect(clean[key]).not.toMatch(/darwin|linux|win32|MacOS|Windows|FreeBSD|arm64|x64|x86/i);
    });
  }
});

function safe(fn) {
  try { return fn(); } catch (e) { return `THROW: ${e.message}`; }
}
