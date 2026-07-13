// @ts-check
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// assertSafeCatalogUrl resolves DNS — keep unit tests offline.
vi.mock("node:dns/promises", () => ({
  default: {
    lookup: async () => [{ address: "140.82.112.3", family: 4 }],
  },
}));

import {
  checkSkillUpdates,
  previewSkillUpdate,
  updateSkillFromSource,
  MAX_SKILLS_PER_CHECK,
} from "@/lib/agent-library/updates.js";
import { sha256Hex, MAX_SKILL_BYTES } from "@/lib/agent-library/catalog.js";

const URL_A = "https://raw.githubusercontent.com/acme/skills/main/a/SKILL.md";

const MD_V1 = "---\nname: demo\ndescription: v1\n---\n\n# Demo skill v1\n";
const MD_V2 = "---\nname: demo\ndescription: v2\n---\n\n# Demo skill v2 changed\n";

/** @type {string} */
let root;
const tmps = [];

/**
 * @param {string} id
 * @param {{ markdown?: string, meta?: Record<string, any>|null }} [opts]
 */
async function seedSkill(id, opts = {}) {
  const dir = path.join(root, "skills", id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), opts.markdown ?? MD_V1, "utf-8");
  if (opts.meta !== null) {
    await fs.writeFile(
      path.join(dir, ".source.json"),
      JSON.stringify(
        opts.meta ?? {
          source: `url:${URL_A}`,
          installedAt: "2026-01-01T00:00:00.000Z",
          contentHash: sha256Hex(opts.markdown ?? MD_V1),
          etag: '"etag-v1"',
        },
        null,
        2
      ),
      "utf-8"
    );
  }
  return dir;
}

/** @param {string} id */
async function readMeta(id) {
  return JSON.parse(
    await fs.readFile(path.join(root, "skills", id, ".source.json"), "utf-8")
  );
}

/**
 * @param {{ status?: number, body?: string, etag?: string|null, contentLength?: number }} r
 */
function mockResponse(r) {
  const headers = new Headers();
  if (r.etag) headers.set("etag", r.etag);
  if (r.contentLength != null) headers.set("content-length", String(r.contentLength));
  const status = r.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    text: async () => r.body ?? "",
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sb-al-upd-"));
  tmps.push(root);
  vi.unstubAllGlobals();
});

afterAll(async () => {
  for (const t of tmps) {
    await fs.rm(t, { recursive: true, force: true }).catch(() => {});
  }
});

describe("checkSkillUpdates", () => {
  it("304 → fresh; lastChecked persisted", async () => {
    await seedSkill("a");
    const fetchMock = vi.fn(async () => mockResponse({ status: 304 }));
    vi.stubGlobal("fetch", fetchMock);

    const { results } = await checkSkillUpdates(root);
    expect(results).toEqual([{ id: "a", status: "fresh" }]);
    expect(fetchMock.mock.calls[0][1].headers["If-None-Match"]).toBe('"etag-v1"');
    const meta = await readMeta("a");
    expect(meta.lastChecked).toBeTruthy();
    expect(meta.contentHash).toBe(sha256Hex(MD_V1));
  });

  it("200 with unchanged content → fresh; etag refreshed", async () => {
    await seedSkill("a");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse({ body: MD_V1, etag: '"etag-v2"' }))
    );

    const { results } = await checkSkillUpdates(root);
    expect(results).toEqual([{ id: "a", status: "fresh" }]);
    const meta = await readMeta("a");
    expect(meta.etag).toBe('"etag-v2"');
  });

  it("200 with changed content → update; installed hash NOT overwritten", async () => {
    await seedSkill("a");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse({ body: MD_V2, etag: '"etag-v2"' }))
    );

    const { results } = await checkSkillUpdates(root);
    expect(results).toEqual([{ id: "a", status: "update" }]);
    const meta = await readMeta("a");
    expect(meta.contentHash).toBe(sha256Hex(MD_V1));
  });

  it("legacy .source.json without contentHash → hash computed from disk and backfilled", async () => {
    await seedSkill("a", {
      meta: { source: `url:${URL_A}`, installedAt: "2026-01-01T00:00:00.000Z" },
    });
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse({ body: MD_V1 })));

    const { results } = await checkSkillUpdates(root);
    expect(results).toEqual([{ id: "a", status: "fresh" }]);
    expect((await readMeta("a")).contentHash).toBe(sha256Hex(MD_V1));
  });

  it("per-skill errors isolated; non-url and metadata-less skills skipped", async () => {
    await seedSkill("bad");
    await seedSkill("good", {
      meta: {
        source: "url:https://raw.githubusercontent.com/acme/skills/main/g/SKILL.md",
        contentHash: sha256Hex(MD_V1),
      },
    });
    await seedSkill("manual", { meta: { source: "manual" } });
    await seedSkill("no-meta", { meta: null });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).includes("/a/")) throw new Error("boom");
        return mockResponse({ body: MD_V1 });
      })
    );

    const { results } = await checkSkillUpdates(root);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId.bad.status).toBe("error");
    expect(byId.good.status).toBe("fresh");
    expect(results).toHaveLength(2); // manual + no-meta never checked
  });

  it("caps work per run and reports the remainder", async () => {
    for (let i = 0; i < MAX_SKILLS_PER_CHECK + 3; i++) {
      await seedSkill(`s${String(i).padStart(2, "0")}`);
    }
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse({ status: 304 })));

    const { results, skipped } = await checkSkillUpdates(root);
    expect(results).toHaveLength(MAX_SKILLS_PER_CHECK);
    expect(skipped).toBe(3);
  });

  it("oversized remote content → error (size cap)", async () => {
    await seedSkill("a");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        mockResponse({ body: MD_V1, contentLength: MAX_SKILL_BYTES + 1 })
      )
    );

    const { results } = await checkSkillUpdates(root);
    expect(results[0].status).toBe("error");
    expect(results[0].message).toMatch(/limit/);
  });
});

describe("previewSkillUpdate", () => {
  it("returns full markdown + hash of exactly that content", async () => {
    await seedSkill("a");
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse({ body: MD_V2 })));

    const res = await previewSkillUpdate(root, "a");
    expect(res.ok).toBe(true);
    expect(res.markdown).toBe(MD_V2);
    expect(res.contentHash).toBe(sha256Hex(MD_V2));
  });

  it("refuses non-url sources", async () => {
    await seedSkill("manual", { meta: { source: "manual" } });
    const res = await previewSkillUpdate(root, "manual");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("not_url_source");
  });
});

describe("updateSkillFromSource", () => {
  it("strict confirm gate: truthy-but-not-true values rejected", async () => {
    await seedSkill("a");
    for (const confirmed of ["true", 1, {}, undefined]) {
      const res = await updateSkillFromSource(root, "a", {
        confirmed: /** @type {any} */ (confirmed),
        expectedHash: sha256Hex(MD_V2),
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe("confirmation_required");
    }
  });

  it("requires expectedHash", async () => {
    await seedSkill("a");
    const res = await updateSkillFromSource(root, "a", {
      confirmed: true,
      expectedHash: /** @type {any} */ (undefined),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("expected_hash_required");
  });

  it("refuses when upstream changed after preview (TOCTOU)", async () => {
    await seedSkill("a");
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse({ body: MD_V2 })));

    const res = await updateSkillFromSource(root, "a", {
      confirmed: true,
      expectedHash: sha256Hex(MD_V1), // previewed v1, upstream now serves v2
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("content_changed");
    // installed file untouched
    const onDisk = await fs.readFile(
      path.join(root, "skills", "a", "SKILL.md"),
      "utf-8"
    );
    expect(onDisk).toBe(MD_V1);
  });

  it("successful update: file overwritten, provenance refreshed, source preserved", async () => {
    await seedSkill("a");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse({ body: MD_V2, etag: '"etag-v2"' }))
    );

    const res = await updateSkillFromSource(root, "a", {
      confirmed: true,
      expectedHash: sha256Hex(MD_V2),
    });
    expect(res.ok).toBe(true);
    expect(res.warning).toMatch(/Apply Sync/i);

    const onDisk = await fs.readFile(
      path.join(root, "skills", "a", "SKILL.md"),
      "utf-8"
    );
    expect(onDisk).toBe(MD_V2);

    const meta = await readMeta("a");
    expect(meta.source).toBe(`url:${URL_A}`);
    expect(meta.contentHash).toBe(sha256Hex(MD_V2));
    expect(meta.etag).toBe('"etag-v2"');
  });
});
