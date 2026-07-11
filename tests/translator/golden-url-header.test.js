// P0 GOLDEN: lock buildUrl + buildHeaders cho mọi provider trên code CŨ.
// Sinh snapshot lần đầu (baseline) → sau refactor chạy lại phải khớp y hệt.
// Mock proxyFetch + uuid-heavy executors KHÔNG cần ở đây vì chỉ gọi buildUrl/buildHeaders (pure).
import { describe, it, expect } from "vitest";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

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

// Sanitize header: khử token, field thời gian động (kimi X-Msh-Device-Id),
// và giá trị phụ thuộc OS/arch để snapshot ổn định trên mọi CI runner
// (darwin arm64 ở local macOS → linux x64 ở CI Ubuntu):
//   - X-PLATFORM            = process.platform            (cline)
//   - X-Msh-Device-Model    = `${platform} ${arch}`       (kimi/moonshot)
//   - X-Stainless-Os        = mapStainlessOs()            (claude/qwen)
//   - X-Stainless-Arch      = mapStainlessArch()          (claude/qwen)
// Các header còn lại (giá trị version, retry-count, timeout...) là hằng số → giữ nguyên
// để vẫn assert ý nghĩa.
function sanitize(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k === "X-CLIENT-VERSION" || k === "X-CORE-VERSION") {
      out[k] = "<VERSION>";
      continue;
    }
    if (k === "X-PLATFORM-VERSION") {
      out[k] = "<NODE_VERSION>";
      continue;
    }
    // Host-dependent platform/arch — phải khử để CI (Ubuntu) khớp local (macOS).
    if (k === "X-PLATFORM" || k === "X-Stainless-Os") {
      out[k] = "<PLATFORM>";
      continue;
    }
    if (k === "X-Stainless-Arch") {
      out[k] = "<ARCH>";
      continue;
    }
    if (k === "X-Msh-Device-Model") {
      out[k] = "<PLATFORM> <ARCH>";
      continue;
    }
    out[k] = typeof v === "string"
      ? v.replace(/Bearer .+/, "Bearer <TOK>")
          .replace(/sk-test-APIKEY|tok-test-ACCESS/g, "<CRED>")
          .replace(/Switchboard\/\d+(?:\.\d+)+/g, "Switchboard/<VERSION>")
          .replace(/kimi-\d{10,}/g, "kimi-<TS>")
      : v;
  }
  return out;
}

const providerIds = Object.keys(PROVIDERS).filter((p) => !SPECIALIZED.has(p)).sort();

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
        apiKey: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : API_KEY_CRED, true))),
        oauth: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : OAUTH_CRED, true))),
        nonStream: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : API_KEY_CRED, false))),
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
      const raw = ex.buildHeaders(API_KEY_CRED, true);
      const clean = sanitize(raw);
      expect(raw[key]).toBeTruthy();               // header thực sự được emit
      expect(clean[key]).toMatch(/^<.+>$/);        // chỉ còn placeholder
      // Không rò rỉ giá trị host cụ thể sau sanitize.
      expect(clean[key]).not.toMatch(/darwin|linux|win32|MacOS|Windows|FreeBSD|arm64|x64|x86/i);
    });
  }
});

function safe(fn) {
  try { return fn(); } catch (e) { return `THROW: ${e.message}`; }
}
