import { describe, it, expect } from "vitest";
import { isValidAwsRegion, safeAwsRegion } from "../../open-sse/utils/awsRegion.js";
import { KiroExecutor } from "../../open-sse/executors/kiro.js";

/**
 * Regression: credential-supplied regions reach `https://svc.${region}.amazonaws.com`
 * URLs. An unvalidated region reassigns the request host (GHSA-6mwv-4mrm-5p3m).
 * src/lib/oauth guards this via assertValidAwsRegion; open-sse must too.
 */
describe("AWS region validation", () => {
  it("accepts real regions and rejects host-injecting ones", () => {
    for (const good of ["us-east-1", "eu-west-2", "ap-southeast-1", "us-gov-west-1"]) {
      expect(isValidAwsRegion(good)).toBe(true);
    }
    for (const bad of [
      "evil.com#",
      "us-east-1.evil.com",
      "evil.com/x?",
      "../../etc",
      "",
      null,
      undefined,
      "US-EAST-1",
    ]) {
      expect(isValidAwsRegion(bad)).toBe(false);
      expect(safeAwsRegion(bad)).toBe("us-east-1");
    }
  });

  const creds = (region) => ({ providerSpecificData: { authMethod: "idc", region } });

  it("kiro executor ignores a host-injecting region", () => {
    const exec = new KiroExecutor();
    const hostile = exec.getOrderedBaseUrls(creds("evil.com#"));
    expect(hostile).toEqual(exec.getOrderedBaseUrls(creds("us-east-1")));
    expect(hostile.join(" ")).not.toContain("evil.com");
  });

  it("kiro executor still honours a legitimate non-default region", () => {
    const exec = new KiroExecutor();
    const urls = exec.getOrderedBaseUrls(creds("eu-west-2"));
    expect(urls.some((u) => u.includes("eu-west-2.amazonaws.com"))).toBe(true);
  });

  it("kiro executor uses the profile region instead of the Identity Center region", () => {
    const exec = new KiroExecutor();
    const urls = exec.getOrderedBaseUrls({
      providerSpecificData: {
        authMethod: "idc",
        region: "eu-west-1",
        profileArn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/PROFILE",
      },
    });

    expect(urls[0]).toContain("q.eu-central-1.amazonaws.com");
    expect(urls.some((u) => u.includes("eu-west-1.amazonaws.com"))).toBe(false);
  });

  it("kiro executor uses the GovCloud FIPS endpoint for a GovCloud profile", () => {
    const exec = new KiroExecutor();
    const urls = exec.getOrderedBaseUrls({
      providerSpecificData: {
        authMethod: "idc",
        region: "us-gov-east-1",
        profileArn:
          "arn:aws-us-gov:codewhisperer:us-gov-west-1:123456789012:profile/PROFILE",
      },
    });

    expect(urls[0]).toContain("q-fips.us-gov-west-1.amazonaws.com");
  });
});
