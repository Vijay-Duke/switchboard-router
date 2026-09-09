// @ts-check
import { NextResponse } from "next/server";
import { validateApiKey } from "@/lib/db/index.js";
import {
  createDashboardSessionToken,
  dashboardSessionCookieAttributes,
  hasValidDashboardSession,
} from "@/lib/auth/dashboardSession.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "no-store" };

// Small in-memory brute-force damper: per-peer attempt budget per window.
// The app is single-user; a Map keyed by best-effort peer is enough.
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;
const attempts = new Map(); // key -> { count, windowStart }

function peerKey(request) {
  // Only trustworthy when custom-server set it (it deletes client copies);
  // otherwise bucket everything into one counter — fails closed on rate.
  const realIp = request.headers.get("x-switchboard-real-ip");
  return process.env.SWITCHBOARD_TRUST_REAL_IP === "1" && realIp ? realIp : "global";
}

function takeAttemptBudget(key) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    attempts.set(key, { count: 1, windowStart: now });
    if (attempts.size > 64) {
      for (const [k, v] of attempts) {
        if (now - v.windowStart >= WINDOW_MS) attempts.delete(k);
      }
    }
    return true;
  }
  entry.count += 1;
  return entry.count <= MAX_ATTEMPTS;
}

/** GET — session status for the sign-in page (never returns the token). */
export async function GET(request) {
  return NextResponse.json(
    { authenticated: await hasValidDashboardSession(request) },
    { headers: NO_STORE },
  );
}

/** POST — exchange a gateway API key for a dashboard session cookie. */
export async function POST(request) {
  try {
    if (!takeAttemptBudget(peerKey(request))) {
      return NextResponse.json(
        { error: "Too many attempts — wait a minute and try again." },
        { status: 429, headers: NO_STORE },
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: NO_STORE });
    }
    const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) {
      return NextResponse.json({ error: "API key required" }, { status: 400, headers: NO_STORE });
    }

    if (!(await validateApiKey(apiKey))) {
      return NextResponse.json({ error: "Invalid API key" }, { status: 401, headers: NO_STORE });
    }

    const token = await createDashboardSessionToken();
    const isHttps = (request.headers.get("x-forwarded-proto") || "").toLowerCase() === "https"
      || new URL(request.url).protocol === "https:";

    return NextResponse.json(
      { ok: true },
      {
        headers: {
          ...NO_STORE,
          "Set-Cookie": dashboardSessionCookieAttributes(token, { secure: isHttps }),
        },
      },
    );
  } catch (error) {
    console.log("Error during dashboard login:", error);
    return NextResponse.json({ error: "Login failed" }, { status: 500, headers: NO_STORE });
  }
}
