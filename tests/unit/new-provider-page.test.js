import { describe, expect, it, vi } from "vitest";
import { validateProviderForm } from "@/app/(dashboard)/dashboard/providers/new/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ children }) => children,
}));

describe("new provider validation (D20)", () => {
  it("requires apiKey for empty cookie credentials", () => {
    expect(
      validateProviderForm({ provider: "openai", authMethod: "cookie", apiKey: "   " }),
    ).toEqual({ apiKey: "API Key is required" });
  });

  it("still requires apiKey for the apikey method", () => {
    expect(
      validateProviderForm({ provider: "openai", authMethod: "apikey", apiKey: "" }),
    ).toEqual({ apiKey: "API Key is required" });
  });

  it("accepts a filled cookie credential", () => {
    expect(
      validateProviderForm({ provider: "openai", authMethod: "cookie", apiKey: "sess-abc" }),
    ).toEqual({});
  });

  it("does not require a credential for oauth", () => {
    expect(
      validateProviderForm({ provider: "openai", authMethod: "oauth", apiKey: "" }),
    ).toEqual({});
  });
});
