// Fal.ai — async submit + queue polling
import { sleep, nowSec, sizeToAspectRatio, POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from "./_base.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";

const PROVIDER = "fal-ai";
const IMAGE_CFG = PROVIDER_MEDIA[PROVIDER]?.imageConfig || {};
const TRANSPORT = { identity: IMAGE_CFG.identity || "openai-node", provider: PROVIDER, format: IMAGE_CFG.format || "openai" };

const BASE_URL = IMAGE_CFG.baseUrl;

const moduleDefault = {
  async: true,
  buildUrl: (model) => `${BASE_URL}/${model}`,
  buildHeaders: (creds) => {
    const key = creds?.apiKey || creds?.accessToken;
    return { "Content-Type": "application/json", "Authorization": `Key ${key}` };
  },
  buildBody: (_model, body) => {
    const req = { prompt: body.prompt, num_images: body.n || 1 };
    if (body.size) req.image_size = sizeToAspectRatio(body.size);
    if (body.image) req.image_url = body.image;
    return req;
  },
  async parseResponse(response, { headers }) {
    const { status_url, response_url } = await response.json();
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const r = await proxyAwareFetch(status_url, { headers, ...TRANSPORT });
      if (!r.ok) throw new Error(`Fal status ${r.status}`);
      const s = await r.json();
      if (s.status === "COMPLETED") {
        const fr = await proxyAwareFetch(response_url, { headers, ...TRANSPORT });
        return await fr.json();
      }
      if (s.status === "FAILED") throw new Error(s.error || "Fal generation failed");
    }
    throw new Error("Fal polling timeout");
  },
  normalize: (responseBody) => {
    const images = Array.isArray(responseBody.images)
      ? responseBody.images
      : (responseBody.image ? [responseBody.image] : []);
    return { created: nowSec(), data: images.map((img) => ({ url: img.url || img })) };
  },
};

export default moduleDefault;
