import { isValidAwsRegion } from "./awsRegion.js";

const KIRO_PROFILE_ARN_PATTERN =
  /^arn:(aws|aws-us-gov):codewhisperer:([^:]+):(\d{12}):profile\/([^/]+)$/;

/**
 * Validate a Kiro profile ARN and return its inference region.
 *
 * IAM Identity Center and the Kiro profile can live in different regions.
 * GenerateAssistantResponse must use the region embedded in the profile ARN.
 */
export function parseKiroProfileArn(value) {
  const profileArn = typeof value === "string" ? value.trim() : "";
  const match = profileArn.match(KIRO_PROFILE_ARN_PATTERN);
  if (!match || !isValidAwsRegion(match[2])) return null;
  return { profileArn, region: match[2] };
}
