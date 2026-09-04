// T91: a non-JSON error response (gateway 500/HTML) must surface the friendly
// fallback message with status context, not a bare SyntaxError.

import { describe, expect, it } from "vitest";
import { requestPickerLabels } from "@/app/(dashboard)/dashboard/cli-tools/components/pickerLabelsClient";

describe("requestPickerLabels error shape (T91)", () => {
  it("throws the friendly fallback on a non-JSON 500", async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 500,
      json: () => Promise.reject(new SyntaxError("Unexpected token '<' ...")),
    });
    await expect(
      requestPickerLabels({ modelIds: ["glm/glm-5.3"], fetchImpl })
    ).rejects.toThrow("Failed to generate picker labels (status 500)");
  });

  it("still prefers the server-provided error message when JSON parses", async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "naming model unavailable" }),
    });
    await expect(
      requestPickerLabels({ modelIds: ["glm/glm-5.3"], fetchImpl })
    ).rejects.toThrow("naming model unavailable");
  });
});
