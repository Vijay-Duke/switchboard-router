import { describe, it, expect } from "vitest";
import { detectRequiredCapabilities } from "../../open-sse/services/combo.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// Hermes / attachment / modality detection cases (upstream 345cdcf6's detection
// half). Uses the REAL capabilities registry — no mocks — so registry regressions
// surface here too.

describe("detectRequiredCapabilities: hermes + attachments", () => {
  it("ollama/hermes images array -> vision", () => {
    const r = detectRequiredCapabilities({
      messages: [{ role: "user", content: "look", images: ["data:image/png;base64,x"] }],
    });
    expect(r.has("vision")).toBe(true);
  });

  it("experimental_attachments contentType image -> vision", () => {
    const r = detectRequiredCapabilities({
      messages: [{
        role: "user",
        content: "look",
        experimental_attachments: [{ contentType: "image/png", url: "https://x/a.png" }],
      }],
    });
    expect(r.has("vision")).toBe(true);
  });

  it("attachments with audio data URI -> audioInput", () => {
    const r = detectRequiredCapabilities({
      messages: [{
        role: "user",
        content: "listen",
        attachments: [{ url: "data:audio/wav;base64,AAAA" }],
      }],
    });
    expect(r.has("audioInput")).toBe(true);
  });

  it("attachments without mime default to vision", () => {
    const r = detectRequiredCapabilities({
      messages: [{ role: "user", content: "look", experimental_attachments: [{ url: "https://x/blob" }] }],
    });
    expect(r.has("vision")).toBe(true);
  });

  it("message-level audio property -> audioInput", () => {
    const r = detectRequiredCapabilities({
      messages: [{ role: "user", content: "listen", audio: { data: "x", format: "wav" } }],
    });
    expect(r.has("audioInput")).toBe(true);
  });

  it("string content data:image sniffing -> vision", () => {
    const r = detectRequiredCapabilities({
      messages: [{ role: "user", content: "here data:image/jpeg;base64,AAAA inline" }],
    });
    expect(r.has("vision")).toBe(true);
  });
});

describe("detectRequiredCapabilities: block types + mime inference", () => {
  it("input_audio block format wav -> audioInput", () => {
    const r = detectRequiredCapabilities({
      messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "x", format: "wav" } }] }],
    });
    expect(r.has("audioInput")).toBe(true);
  });

  it("input_video block -> videoInput", () => {
    const r = detectRequiredCapabilities({
      messages: [{ role: "user", content: [{ type: "input_video", input_video: { data: "x" } }] }],
    });
    expect(r.has("videoInput")).toBe(true);
  });

  it("file block source.media_type application/pdf -> pdf", () => {
    const r = detectRequiredCapabilities({
      messages: [{ role: "user", content: [
        { type: "document", source: { media_type: "application/pdf", data: "x" } },
      ] }],
    });
    expect(r.has("pdf")).toBe(true);
  });

  it("generic file block without mime falls back to pdf", () => {
    const r = detectRequiredCapabilities({
      messages: [{ role: "user", content: [{ type: "file", file: { filename: "a.bin" } }] }],
    });
    expect(r.has("pdf")).toBe(true);
  });

  it("video mime via gemini fileData -> videoInput", () => {
    const r = detectRequiredCapabilities({
      contents: [{ role: "user", parts: [{ fileData: { mimeType: "video/mp4", fileUri: "gs://x/v.mp4" } }] }],
    });
    expect(r.has("videoInput")).toBe(true);
  });

  it("only the trailing user run is scanned (older image turn ignored)", () => {
    const r = detectRequiredCapabilities({
      messages: [
        { role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] },
        { role: "assistant", content: "saw it" },
        { role: "user", content: "text only now" },
      ],
    });
    expect(r.size).toBe(0);
  });
});

describe("registry: mimo-v2.5 adapter coverage", () => {
  // The default capacity-adapter fallback model must actually cover the modalities.
  it("oc/mimo-v2.5-free reports vision + audioInput + videoInput", () => {
    const caps = getCapabilitiesForModel("opencode", "mimo-v2.5-free");
    expect(caps.vision).toBe(true);
    expect(caps.audioInput).toBe(true);
    expect(caps.videoInput).toBe(true);
  });
});
