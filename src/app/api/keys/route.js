// @ts-check
import { NextResponse } from "next/server";
import { getApiKeys, createApiKey } from "@/lib/db/index.js";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const dynamic = "force-dynamic";

// Serializes findOrCreate requests so two tabs auto-provisioning the same
// default key on a fresh install cannot both observe "no key" and insert.
let findOrCreateChain = Promise.resolve();

async function findOrCreateKey(name, machineId) {
  const existing = (await getApiKeys()).find((key) => key.name === name);
  if (existing) return { apiKey: existing, created: false };
  return { apiKey: await createApiKey(name, machineId), created: true };
}

// GET /api/keys - List API keys
export async function GET() {
  try {
    const keys = await getApiKeys();
    return NextResponse.json({ keys });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
export async function POST(request) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    const name = body.name.trim();

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    if (body.findOrCreate === true) {
      const run = findOrCreateChain.then(() => findOrCreateKey(name, machineId));
      findOrCreateChain = run.catch(() => {});
      const { apiKey, created } = await run;
      // An existing key's secret is not recoverable; callers re-list after this.
      return NextResponse.json(apiKey, { status: created ? 201 : 200 });
    }

    const apiKey = await createApiKey(name, machineId);

    return NextResponse.json(apiKey, { status: 201 });
  } catch (error) {
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
