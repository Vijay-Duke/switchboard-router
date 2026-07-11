import { describe, expect, it } from "vitest";

import { handleEmbeddings } from "../../src/sse/handlers/embeddings.js";
import { handleSearch } from "../../src/sse/handlers/search.js";

function nullRequest(path) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null",
  });
}

describe("API JSON body validation", () => {
  it("returns 400 for a null embeddings body", async () => {
    await expect(handleEmbeddings(nullRequest("/v1/embeddings"))).resolves.toMatchObject({ status: 400 });
  });

  it("returns 400 for a null search body", async () => {
    await expect(handleSearch(nullRequest("/v1/search"))).resolves.toMatchObject({ status: 400 });
  });
});
