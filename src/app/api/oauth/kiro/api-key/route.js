// @ts-check
import { NextResponse } from "next/server";
import { KiroService } from "@/lib/oauth/services/kiro";
import { createProviderConnection } from "@/models";

/**
 * POST /api/oauth/kiro/api-key
 * Import a Kiro API key (headless auth). The key is a long-lived bearer
 * credential — there is no refresh token. It is validated with a real
 * authenticated CodeWhisperer call (ListAvailableModels), then stored with
 * authMethod="api_key". A connection is only saved when validation succeeds, so
 * a key that cannot authenticate is never persisted as "active".
 */
export async function POST(request) {
  try {
    const { apiKey, region } = await request.json();

    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      return NextResponse.json(
        { error: "API key is required" },
        { status: 400 }
      );
    }

    const kiroService = new KiroService();

    // Validate the key with a real authenticated CodeWhisperer call. Throws a
    // tagged error (handled below) if the key cannot authenticate.
    const credential = await kiroService.validateApiKey(
      apiKey,
      region || "us-east-1"
    );

    // Extract email from JWT if the key happens to be a JWT (optional display)
    const email = kiroService.extractEmailFromJWT(credential.accessToken);

    // API keys never expire on a fixed schedule; persist a long horizon so the
    // proactive refresh path (which requires a refreshToken anyway) is skipped.
    const connection = await createProviderConnection({
      provider: "kiro",
      authType: "api_key",
      accessToken: credential.accessToken,
      refreshToken: null,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      email: email || null,
      providerSpecificData: {
        profileArn: credential.profileArn,
        region: credential.region,
        authMethod: "api_key",
        provider: "API Key",
      },
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
      },
    });
  } catch (error) {
    console.log("Kiro API key import error:", error?.code || "", error?.message || error);
    // validateApiKey throws tagged errors (error.code). Its messages are curated
    // and never contain the upstream response body (SSRF hardening), so they are
    // safe to return to the client. Map the code to an accurate HTTP status.
    const code = error?.code;
    const status =
      code === "MISSING_KEY" || code === "REGION_UNAVAILABLE" ? 400 :
      code === "AUTH_REJECTED" ? 401 :
      code === "NETWORK_ERROR" ? 502 :
      code === "VALIDATION_FAILED" ? 502 :
      500;
    const message = code
      ? error.message
      : "API key validation failed";
    return NextResponse.json({ error: message, code: code || null }, { status });
  }
}
