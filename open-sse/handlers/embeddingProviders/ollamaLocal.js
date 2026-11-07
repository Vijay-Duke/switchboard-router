import { resolveOllamaLocalHost } from "../../config/providers.js";

// Ollama Local serves OpenAI-compatible /v1/embeddings. Strip an endpoint path
// saved on the host (…/v1 or …/v1/embeddings) so it never doubles up.
const moduleDefault = {
  buildUrl: (_model, creds) => {
    const host = String(resolveOllamaLocalHost(creds) || "")
      .replace(/\/+$/, "")
      .replace(/\/v1\/embeddings$/, "")
      .replace(/\/v1$/, "");
    return `${host}/v1/embeddings`;
  },
  // Authorization only when a key is configured (authenticated reverse proxies).
  buildHeaders: (creds) => {
    const headers = { "Content-Type": "application/json" };
    if (creds?.apiKey) headers["Authorization"] = `Bearer ${creds.apiKey}`;
    return headers;
  },
  buildBody: (model, { input, encoding_format, dimensions }) => {
    const body = { model, input };
    if (encoding_format) body.encoding_format = encoding_format;
    if (dimensions != null && dimensions !== "") {
      const dim = Number(dimensions);
      if (Number.isFinite(dim) && dim > 0) body.dimensions = dim;
    }
    return body;
  },
  normalize: (responseBody) => responseBody,
};

export default moduleDefault;
