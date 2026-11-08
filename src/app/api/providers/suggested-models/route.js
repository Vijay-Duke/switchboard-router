// @ts-check
import { NextResponse } from "next/server";
import REGISTRY from "open-sse/providers/registry/index.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { assertPublicUrlResolved } from "open-sse/utils/ssrfGuard.js";
import { FILTERS } from "./filters.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  const type = searchParams.get("type");

  if (!url || !type) {
    return NextResponse.json({ error: "Missing url or type" }, { status: 400 });
  }

  const filter = FILTERS[type];
  if (!filter) {
    return NextResponse.json({ error: "Unknown filter type" }, { status: 400 });
  }

  const provider = REGISTRY.find(entry => entry.modelsFetcher?.url === url && entry.modelsFetcher.type === type && !entry.modelsFetcher.requiresAuth);
  if (!provider) return NextResponse.json({ error: "Unknown public model catalog" }, { status: 400 });
  try {
    await assertPublicUrlResolved(url);
    const timeout = AbortSignal.timeout(10000);
    const res = await proxyAwareFetch(url, {
      identity: provider.transport?.identity || "openai-node", provider: provider.id,
      format: provider.transport?.format || "openai", redirect: "error",
      signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
    });
    if (!res.ok) {
      return NextResponse.json({ data: [] });
    }
    const json = await res.json();
    const raw = json.data ?? json.models ?? json;
    // Object-shaped catalogs (minimax-code's {providers:[…]}) ride in as a
    // single-element array so every filter keeps an array input contract.
    const data = filter(Array.isArray(raw) ? raw : typeof raw === "object" && raw !== null ? [raw] : []);
    return NextResponse.json({ data });
  } catch {
    return NextResponse.json({ data: [] });
  }
}
