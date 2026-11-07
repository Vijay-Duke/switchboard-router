// Antigravity image adapter - delegates to the executor for correct request
// envelope (project, model, requestType, sessionId) and auth headers.
import { nowSec, sizeToAspectRatio } from "./_base.js";
import { getExecutor } from "../../executors/index.js";

// Convert image input (data URI or raw base64) to Gemini inlineData part
function resolveImageInput(input) {
  if (!input || typeof input !== "string") return null;
  // data:image/png;base64,... format
  const dataUriMatch = input.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (dataUriMatch) {
    return { inlineData: { mimeType: dataUriMatch[1], data: dataUriMatch[2] } };
  }
  // Raw base64 string (assume PNG)
  if (/^[A-Za-z0-9+/]/.test(input) && input.length > 100 && !input.startsWith("http")) {
    return { inlineData: { mimeType: "image/png", data: input } };
  }
  return null;
}

const moduleDefault = {
  // Delegate to executor instead of building URL/headers/body manually
  useExecutor: true,

  // Stubs - required by imageGenerationCore interface but unused with useExecutor
  buildUrl: () => "",
  buildHeaders: () => ({}),
  buildBody: () => ({}),

  async executeViaExecutor(model, body, credentials, log, opts = {}) {
    const executor = getExecutor("antigravity");
    if (!executor) throw new Error("Antigravity executor not found");

    const { signal } = opts;

    // Ensure we use an image model for image generation
    const isImageModel = (m) => /image|imagen|image-generation/i.test(m || "");
    let targetModel = isImageModel(model) ? model : "gemini-3.1-flash-image";

    // body.size → aspect ratio, appended as a -WxH suffix the executor's
    // parseImageConfig reads. An explicit suffix on the model id wins.
    if (body.size && typeof body.size === "string" && !/-\d+x\d+$/.test(targetModel)) {
      const suffix = sizeToAspectRatio(body.size).replace(":", "x");
      targetModel = `${targetModel}-${suffix}`;
    }

    // Build parts: text prompt + optional input image for editing
    const parts = [{ text: body.prompt }];
    const imageInput = body.image || (Array.isArray(body.images) && body.images[0]);
    if (imageInput) {
      const inlineData = resolveImageInput(imageInput);
      if (inlineData) parts.unshift(inlineData);
    }

    const chatBody = {
      contents: [{ role: "user", parts }],
    };

    const result = await executor.execute({
      model: targetModel,
      body: chatBody,
      signal,
      stream: false,
      credentials,
      log,
    });

    if (!result.response.ok) {
      const text = await result.response.text();
      const err = new Error(text || `HTTP ${result.response.status}`);
      err.status = result.response.status;
      // Google quota errors carry the exact reset in error.details[].metadata.
      try {
        const details = JSON.parse(text).error?.details || [];
        for (const d of details) {
          const ms = d?.metadata?.quotaResetTimeStamp ? new Date(d.metadata.quotaResetTimeStamp).getTime() : NaN;
          if (ms > Date.now()) { err.resetsAtMs = ms; break; }
        }
      } catch { /* non-JSON error body */ }
      throw err;
    }

    return result.response.json();
  },

  normalize: (responseBody) => {
    const candidates = responseBody.candidates || responseBody.response?.candidates || [];
    const parts = candidates[0]?.content?.parts || [];
    const images = parts.filter((p) => p.inlineData?.data).map((p) => ({
      b64_json: p.inlineData.data,
    }));
    return { created: nowSec(), data: images };
  },
};

export default moduleDefault;