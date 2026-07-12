import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let repo;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-rstats-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  repo = await import("@/lib/db/repos/routingRepo.js");

  const now = new Date().toISOString();
  const yesterday = new Date(Date.now() - 86400000).toISOString();
  await Promise.all([
    repo.insertRoutingEvent({
      timestamp: now,
      comboName: "combo-a",
      cluster: "cluster-one",
      pickedWorker: "worker-alpha",
      routerReason: "router",
      workerLatencyMs: 100,
      outcomeScore: 80,
      meta: { terminal: true },
    }),
    repo.insertRoutingEvent({
      timestamp: now,
      comboName: "combo-b",
      cluster: "cluster-two",
      pickedWorker: "worker-alpha",
      routerReason: "router",
      workerLatencyMs: 300,
      outcomeScore: 40,
      meta: { terminal: true },
    }),
    repo.insertRoutingEvent({
      timestamp: now,
      comboName: "combo-a",
      cluster: "cluster-one",
      pickedWorker: "worker-alpha",
      routerReason: "router",
      workerLatencyMs: 10,
      outcomeScore: 100,
      meta: { terminal: true, skippedRouter: true },
    }),
    repo.insertRoutingEvent({
      timestamp: now,
      comboName: "combo-a",
      cluster: "cluster-one",
      pickedWorker: "worker-alpha",
      routerReason: "router",
      workerLatencyMs: 10,
      outcomeScore: 0,
      meta: { terminal: false },
    }),
    repo.insertRoutingEvent({
      timestamp: now,
      comboName: "combo-timeline",
      cluster: "timeline",
      pickedWorker: "worker-timeline",
      routerReason: "router",
      workerLatencyMs: 20,
      outcomeScore: 90,
      meta: { terminal: true },
    }),
    repo.insertRoutingEvent({
      timestamp: now,
      comboName: "combo-timeline",
      cluster: "timeline",
      pickedWorker: "worker-timeline",
      routerReason: "router",
      workerLatencyMs: 20,
      outcomeScore: 70,
      meta: { terminal: true },
    }),
    repo.insertRoutingEvent({
      timestamp: yesterday,
      comboName: "combo-timeline",
      cluster: "timeline",
      pickedWorker: "worker-timeline",
      routerReason: "router",
      workerLatencyMs: 20,
      outcomeScore: 50,
      meta: { terminal: true },
    }),
    repo.insertRoutingEvent({
      timestamp: now,
      comboName: "combo-timeline",
      cluster: "timeline",
      pickedWorker: "worker-other",
      routerReason: "router",
      workerLatencyMs: 20,
      outcomeScore: 60,
      meta: { terminal: true },
    }),
    repo.insertRoutingEvent({
      timestamp: now,
      comboName: "combo-pick-source",
      cluster: "source",
      pickedWorker: "worker-source",
      routerReason: "router",
      outcomeScore: 70,
      meta: { terminal: true },
    }),
    repo.insertRoutingEvent({
      timestamp: now,
      comboName: "combo-pick-source",
      cluster: "source",
      pickedWorker: "worker-source",
      routerReason: "bandit_policy",
      outcomeScore: 70,
      meta: { terminal: true },
    }),
    repo.insertRoutingEvent({
      timestamp: now,
      comboName: "combo-pick-source",
      cluster: "source",
      pickedWorker: "worker-source",
      routerReason: "exploration:foo",
      fallbackUsed: true,
      outcomeScore: 70,
      meta: { terminal: true },
    }),
    repo.insertRoutingEvent({
      timestamp: now,
      comboName: "combo-pick-source",
      cluster: "source",
      pickedWorker: "worker-source",
      routerReason: "cached_route",
      outcomeScore: 70,
      meta: { terminal: true },
    }),
    repo.insertRoutingEvent({
      timestamp: now,
      comboName: "combo-pick-source",
      cluster: "source",
      pickedWorker: "worker-source",
      routerReason: "judge_flag_escalation",
      outcomeScore: 70,
      meta: { terminal: true },
    }),
    repo.insertRoutingEvent({
      timestamp: now,
      comboName: "combo-pick-source",
      cluster: "source",
      pickedWorker: "worker-source",
      routerReason: "retry",
      fallbackUsed: true,
      outcomeScore: 70,
      meta: { terminal: true },
    }),
    repo.insertRoutingEvent({
      timestamp: now,
      comboName: "combo-judge-coverage",
      cluster: "judge",
      pickedWorker: "worker-judge",
      outcomeScore: 70,
      meta: { terminal: true, judgeScore: 9 },
    }),
    repo.insertRoutingEvent({
      timestamp: now,
      comboName: "combo-judge-coverage",
      cluster: "judge",
      pickedWorker: "worker-judge",
      outcomeScore: 70,
      meta: { terminal: true },
    }),
  ]);
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("routing stats aggregates", () => {
  it("aggregates global model statistics across combos by cluster", async () => {
    const stats = await repo.getGlobalModelStats(14);
    const alpha = stats.find((row) => row.worker === "worker-alpha");

    expect(alpha).toMatchObject({
      n: 2,
      wins: 1,
      winRate: 0.5,
      avgScore: 60,
      avgLatencyMs: 200,
    });
    expect(alpha.clusters).toEqual({
      "cluster-one": { n: 1, avgScore: 80 },
      "cluster-two": { n: 1, avgScore: 40 },
    });
  });

  it("excludes skipped-router and non-terminal rows from every aggregate", async () => {
    const timeline = await repo.getComboScoreTimeline("combo-a", 14);
    const pickSource = await repo.getPickSourceCounts("combo-a", 14);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ n: 1, avgScore: 80 });
    expect(pickSource).toEqual({
      router: 1,
      bandit_policy: 0,
      cached_route: 0,
      exploration: 0,
      judge_flag_escalation: 0,
      fallback_rescue: 0,
    });
  });

  it("groups combo score timelines by day and worker", async () => {
    const timeline = await repo.getComboScoreTimeline("combo-timeline", 14);
    const currentDay = new Date().toISOString().slice(0, 10);
    const yesterdayDay = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    expect(timeline).toEqual(expect.arrayContaining([
      { day: currentDay, worker: "worker-timeline", n: 2, avgScore: 80 },
      { day: yesterdayDay, worker: "worker-timeline", n: 1, avgScore: 50 },
      { day: currentDay, worker: "worker-other", n: 1, avgScore: 60 },
    ]));
  });

  it("reports judged terminal coverage", async () => {
    expect(await repo.getJudgeCoverage("combo-judge-coverage", 14)).toEqual({
      judged: 1,
      total: 2,
    });
  });

  it("classifies pick sources with every bucket present", async () => {
    const counts = await repo.getPickSourceCounts("combo-pick-source", 14);

    expect(counts).toEqual({
      router: 1,
      bandit_policy: 1,
      cached_route: 1,
      exploration: 1,
      judge_flag_escalation: 1,
      fallback_rescue: 1,
    });
    expect(await repo.getPickSourceCounts("", 14)).toEqual({
      router: 0,
      bandit_policy: 0,
      cached_route: 0,
      exploration: 0,
      judge_flag_escalation: 0,
      fallback_rescue: 0,
    });
  });
});
