import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { translateResponse, initState } from "../../open-sse/translator/index.js";

export function normalize(value) {
  const timestampsNormalized = JSON.parse(JSON.stringify(value, (key, current) => {
    if (key === "created" || key === "created_at") return 0;
    return current;
  }));

  return JSON.parse(JSON.stringify(timestampsNormalized, (_key, current) => {
    if (typeof current !== "string") return current;

    return current
      .replace(/resp_\d{6,}/g, "resp_<ID>")
      .replace(/chatcmpl-\d{6,}/g, "chatcmpl-<ID>")
      .replace(/msg_[0-9a-fA-F]{6,}/g, "msg_<ID>")
      .replace(/\b\d{13}\b/g, "<TS_MS>")
      .replace(/\b\d{10}\b/g, "<TS_S>");
  }));
}

export function assertGolden(name, actual) {
  const normalized = normalize(actual);
  const goldenPath = fileURLToPath(new URL(`./__golden__/${name}.json`, import.meta.url));

  if (process.env.UPDATE_GOLDEN) {
    fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
    fs.writeFileSync(goldenPath, `${JSON.stringify(normalized, null, 2)}\n`);
    return;
  }

  if (!fs.existsSync(goldenPath)) {
    throw new Error(`Missing golden fixture: ${goldenPath}. Set UPDATE_GOLDEN=1 to create it.`);
  }

  expect(normalized).toEqual(JSON.parse(fs.readFileSync(goldenPath, "utf8")));
}

export function runResponseStream(upstreamFormat, clientFormat, upstreamChunks) {
  const state = initState(clientFormat);
  const output = [];

  for (const chunk of upstreamChunks) {
    const translated = translateResponse(upstreamFormat, clientFormat, chunk, state);
    if (Array.isArray(translated)) output.push(...translated);
    else if (translated) output.push(translated);
  }

  return output;
}
