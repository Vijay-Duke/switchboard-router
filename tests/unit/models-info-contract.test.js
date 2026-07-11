import { describe, expect, it } from "vitest";

import { GET } from "../../src/app/api/v1/models/info/route.js";

describe("single-model metadata endpoints", () => {
  it("advertises the implemented web-fetch route", async () => {
    const response = await GET(new Request("http://localhost/v1/models/info?id=jina-reader/fetch"));
    expect(response.status).toBe(200);
    expect((await response.json()).endpoint).toBe("/v1/web/fetch");
  });
});
