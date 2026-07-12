import { getAdapter } from "../driver.js";
import { stringifyJson, parseJson } from "../helpers/jsonCol.js";
import { randomUUID } from "crypto";
import { recomputeStoredOutcome } from "open-sse/routing/scoring.js";
import { providerOf } from "open-sse/routing/providerPreference.js";

function nowIso() {
  return new Date().toISOString();
}

/** Soft invalidate hook — set by chat glue so hot-path cache stays fresh. */
let onRoutingWrite = null;
export function setRoutingWriteHook(fn) {
  onRoutingWrite = typeof fn === "function" ? fn : null;
}
function notifyWrite(comboName) {
  try {
    onRoutingWrite?.(comboName);
  } catch {
    /* ignore */
  }
}

/** @param {Record<string, any>} event */
export async function insertRoutingEvent(event) {
  const db = await getAdapter();
  db.run(
    `INSERT INTO routing_events(
      timestamp, comboName, sessionId, requestId, requestFingerprint, cluster,
      routerModel, pickedWorker, alternates, routerReason, routerConfidence,
      routerLatencyMs, workerStatus, workerLatencyMs, fallbackUsed, retries,
      tokensIn, tokensOut, outcomeScore, objective, learningVersionId, meta
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      event.timestamp || nowIso(),
      event.comboName,
      event.sessionId || null,
      event.requestId || null,
      event.requestFingerprint || null,
      event.cluster || null,
      event.routerModel || null,
      event.pickedWorker || null,
      event.alternates != null ? stringifyJson(event.alternates) : null,
      event.routerReason || null,
      event.routerConfidence || null,
      event.routerLatencyMs ?? null,
      event.workerStatus ?? null,
      event.workerLatencyMs ?? null,
      // Request-level: did this chat use any fallback/rescue (not "this worker retried")
      event.fallbackUsed ? 1 : 0,
      event.retries ?? 0,
      event.tokensIn ?? null,
      event.tokensOut ?? null,
      event.outcomeScore ?? null,
      event.objective || null,
      event.learningVersionId || null,
      event.meta != null ? stringifyJson(event.meta) : null,
    ]
  );
  // Do NOT notifyWrite here — event inserts are high-frequency and would
  // thrash the 15s stats/learning cache on every auto request. Learning
  // version create/promote/rollback, retention, delete, and rekey still
  // invalidate; TTL covers aggregate staleness.
}

/**
 * Recompute + persist outcomeScore for the terminal event(s) of one request
 * after a user rating and/or judge score (Auto v2 quality signal).
 * Shared by the feedback endpoint and the async LLM-judge.
 *
 * Does NOT notifyWrite: adjustments are low-frequency relative to inserts and the
 * 15s stats/learning TTL (plus the next relearn) picks the new scores up — same
 * rationale as insertRoutingEvent skipping invalidation.
 *
 * @param {string} requestId
 * @param {{ userRating?: number, judgeScore?: number }} update
 * @returns {Promise<{ updated: number, comboName?: string }>}
 */
async function applyOutcomeAdjustmentByRequestId(requestId, update) {
  if (!requestId || typeof requestId !== "string") return { updated: 0 };
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM routing_events WHERE requestId = ?`, [requestId]);
  if (!rows?.length) return { updated: 0 };
  // Only the terminal row(s) carry the request's scored outcome. Legacy rows with
  // no terminal flag are treated as terminal (one row per request pre-fix).
  const targets = rows.filter((r) => {
    const meta = parseJson(r.meta, {});
    return meta?.terminal === true || meta?.terminal == null;
  });
  if (!targets.length) return { updated: 0 };

  let updated = 0;
  db.transaction(() => {
    for (const r of targets) {
      const meta = parseJson(r.meta, {});
      const { outcomeScore, meta: nextMeta } = recomputeStoredOutcome(
        meta,
        r.outcomeScore,
        update
      );
      db.run(`UPDATE routing_events SET outcomeScore = ?, meta = ? WHERE id = ?`, [
        outcomeScore,
        stringifyJson(nextMeta),
        r.id,
      ]);
      updated += 1;
    }
  });
  return { updated, comboName: rows[0].comboName };
}

/** Feedback endpoint: set/clear the user rating (1 | -1 | 0) for a request. */
export async function setUserRatingByRequestId(requestId, rating) {
  return applyOutcomeAdjustmentByRequestId(requestId, { userRating: rating });
}

/** LLM-judge: fold a 0–10 judge score into a request's terminal event. */
export async function applyJudgeScoreByRequestId(requestId, judgeScore) {
  return applyOutcomeAdjustmentByRequestId(requestId, { judgeScore });
}

/** Latest terminal routing event for feedback's ephemeral routing side effects. */
export async function getRoutingEventByRequestId(requestId) {
  if (!requestId) return null;
  const db = await getAdapter();
  const row = db.get(
    `SELECT comboName, cluster, pickedWorker FROM routing_events
     WHERE requestId = ?
       AND (meta LIKE '%"terminal":true%' OR meta IS NULL OR meta NOT LIKE '%"terminal"%')
     ORDER BY id DESC LIMIT 1`,
    [requestId]
  );
  if (!row) return null;
  const event = mapEvent(row);
  return {
    comboName: event.comboName,
    cluster: event.cluster,
    pickedWorker: event.pickedWorker,
  };
}

export async function getPromotedLearningVersion(comboName) {
  const db = await getAdapter();
  const row = db.get(
    `SELECT * FROM router_learning_versions
     WHERE comboName = ? AND promoted = 1
     ORDER BY version DESC LIMIT 1`,
    [comboName]
  );
  return row ? mapVersion(row) : null;
}

export async function listLearningVersions(comboName, limit = 20) {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT * FROM router_learning_versions
     WHERE comboName = ?
     ORDER BY version DESC LIMIT ?`,
    [comboName, limit]
  );
  return rows.map(mapVersion);
}

function mapVersion(row) {
  return {
    id: row.id,
    comboName: row.comboName,
    version: row.version,
    createdAt: row.createdAt,
    source: row.source,
    banditTable: parseJson(row.banditTable, {}),
    learnedRules: parseJson(row.learnedRules, []),
    fewShots: parseJson(row.fewShots, []),
    evalScore: row.evalScore,
    prevVersionId: row.prevVersionId,
    promoted: !!row.promoted,
    notes: row.notes,
  };
}

/**
 * Create a learning version; optionally promote it (demotes prior).
 * Entire max-version → demote → insert is one transaction.
 * @param {object} opts
 */
export async function createLearningVersion({
  comboName,
  source = "manual",
  banditTable = {},
  learnedRules = [],
  fewShots = [],
  evalScore = null,
  notes = "",
  promote = false,
  prevVersionId = null,
}) {
  const db = await getAdapter();
  const id = randomUUID();
  const createdAt = nowIso();
  let version = 1;

  db.transaction(() => {
    const maxRow = db.get(
      `SELECT MAX(version) AS v FROM router_learning_versions WHERE comboName = ?`,
      [comboName]
    );
    version = (maxRow?.v || 0) + 1;

    if (promote) {
      db.run(`UPDATE router_learning_versions SET promoted = 0 WHERE comboName = ?`, [
        comboName,
      ]);
    }

    db.run(
      `INSERT INTO router_learning_versions(
        id, comboName, version, createdAt, source, banditTable, learnedRules,
        fewShots, evalScore, prevVersionId, promoted, notes
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        comboName,
        version,
        createdAt,
        source,
        stringifyJson(banditTable),
        stringifyJson(learnedRules),
        stringifyJson(fewShots),
        evalScore,
        prevVersionId,
        promote ? 1 : 0,
        notes || null,
      ]
    );
  });

  notifyWrite(comboName);
  return getLearningVersionById(id);
}

export async function getLearningVersionById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM router_learning_versions WHERE id = ?`, [id]);
  return row ? mapVersion(row) : null;
}

export async function promoteLearningVersion(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM router_learning_versions WHERE id = ?`, [id]);
  if (!row) return null;
  db.transaction(() => {
    db.run(`UPDATE router_learning_versions SET promoted = 0 WHERE comboName = ?`, [
      row.comboName,
    ]);
    db.run(`UPDATE router_learning_versions SET promoted = 1 WHERE id = ?`, [id]);
  });
  notifyWrite(row.comboName);
  return getLearningVersionById(id);
}

export async function rollbackLearningVersion(comboName) {
  const current = await getPromotedLearningVersion(comboName);
  if (!current?.prevVersionId) return null;
  return promoteLearningVersion(current.prevVersionId);
}

/**
 * Request-level event count for minEvents / insights status.
 * Fallback chains write multiple attempt rows; we COUNT(DISTINCT requestId)
 * so one chat = one. Rows without requestId (pre-migration) count via id.
 * Skipped-router heuristic/single-worker rows are excluded when meta marks them.
 *
 * @param {string} comboName
 * @param {string|null} [sinceIso]
 * @param {{ terminalOnly?: boolean }} [opts]
 *   terminalOnly (default true): only meta.terminal=true rows, plus legacy rows
 *   that have no terminal flag (pre-fix data treated as one-per-row).
 */
export async function countRoutingEvents(comboName, sinceIso = null, opts = {}) {
  const db = await getAdapter();
  const terminalOnly = opts.terminalOnly !== false;
  // Portable JSON-ish filters (no JSON1 required)
  // Always exclude skippedRouter (and client-disconnect skips) — even when terminal:true
  const skipRouter = `(meta IS NULL OR meta NOT LIKE '%"skippedRouter":true%')`;
  const terminalClause = terminalOnly
    ? `AND (
         meta LIKE '%"terminal":true%'
         OR (meta IS NULL OR meta NOT LIKE '%"terminal"%')
       )
       AND ${skipRouter}`
    : `AND ${skipRouter}`;

  if (sinceIso) {
    const r = db.get(
      `SELECT COUNT(DISTINCT COALESCE(requestId, CAST(id AS TEXT))) AS n
       FROM routing_events
       WHERE comboName = ? AND timestamp >= ?
         ${terminalClause}`,
      [comboName, sinceIso]
    );
    return r?.n || 0;
  }
  const r = db.get(
    `SELECT COUNT(DISTINCT COALESCE(requestId, CAST(id AS TEXT))) AS n
     FROM routing_events
     WHERE comboName = ?
       ${terminalClause}`,
    [comboName]
  );
  return r?.n || 0;
}

/** Raw attempt rows (includes intermediate fallback failures). */
export async function countRoutingAttempts(comboName, sinceIso = null) {
  const db = await getAdapter();
  if (sinceIso) {
    const r = db.get(
      `SELECT COUNT(*) AS n FROM routing_events
       WHERE comboName = ? AND timestamp >= ?
         AND (meta IS NULL OR meta NOT LIKE '%"skippedRouter":true%')`,
      [comboName, sinceIso]
    );
    return r?.n || 0;
  }
  const r = db.get(
    `SELECT COUNT(*) AS n FROM routing_events
     WHERE comboName = ?
       AND (meta IS NULL OR meta NOT LIKE '%"skippedRouter":true%')`,
    [comboName]
  );
  return r?.n || 0;
}

export async function getRoutingEvents(comboName, { days = 14, limit = 200, terminalOnly = false } = {}) {
  const db = await getAdapter();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const term =
    terminalOnly
      ? `AND (
           meta LIKE '%"terminal":true%'
           OR meta IS NULL
           OR meta NOT LIKE '%"terminal"%'
         )`
      : "";
  const rows = db.all(
    `SELECT * FROM routing_events
     WHERE comboName = ? AND timestamp >= ?
       ${term}
     ORDER BY timestamp DESC LIMIT ?`,
    [comboName, since, limit]
  );
  return rows.map(mapEvent);
}

/**
 * Mean outcomeScore per calendar day over the full window (not last-N-row truncated).
 * Uses terminal request rows only so multi-attempt chains don't double-weight.
 */
export async function getScoreTrendByDay(comboName, days = 14) {
  const db = await getAdapter();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db.all(
    `SELECT substr(timestamp, 1, 10) AS day,
            AVG(outcomeScore) AS avgScore,
            COUNT(*) AS n
     FROM routing_events
     WHERE comboName = ? AND timestamp >= ?
       AND outcomeScore IS NOT NULL
       AND (meta IS NULL OR meta NOT LIKE '%"skippedRouter":true%')
       AND (
         meta LIKE '%"terminal":true%'
         OR meta IS NULL
         OR meta NOT LIKE '%"terminal"%'
       )
     GROUP BY day
     ORDER BY day`,
    [comboName, since]
  );
  return (rows || []).map((r) => ({
    day: r.day,
    avgScore: r.avgScore != null ? Number(r.avgScore) : null,
    n: Number(r.n) || 0,
  }));
}

/** Latest scheduled relearn timestamp for a combo (scheduler persistence). */
export async function getLastScheduledLearnAt(comboName) {
  if (!comboName) return null;
  const db = await getAdapter();
  const row = db.get(
    `SELECT MAX(createdAt) AS t FROM router_learning_versions
     WHERE comboName = ? AND source = 'scheduled'`,
    [comboName]
  );
  return row?.t || null;
}

function mapEvent(row) {
  return {
    ...row,
    alternates: parseJson(row.alternates, []),
    meta: parseJson(row.meta, {}),
    fallbackUsed: !!row.fallbackUsed,
  };
}

/**
 * Cluster × worker aggregates for heatmap / bandit.
 * Excludes skippedRouter rows so heuristic/single-worker shortcuts don't poison learning.
 * wins = COUNT where outcomeScore >= 60 (LEARNING.md §Bandit).
 */
export async function getClusterWorkerStats(comboName, days = 14) {
  const db = await getAdapter();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  // Filter skippedRouter via LIKE — portable across sqlite adapters without requiring JSON1
  return db.all(
    `SELECT cluster, pickedWorker,
            COUNT(*) AS n,
            SUM(CASE WHEN outcomeScore >= 60 THEN 1 ELSE 0 END) AS wins,
            AVG(outcomeScore) AS avgScore,
            AVG(workerLatencyMs) AS avgLatencyMs,
            AVG(tokensOut) AS avgTokensOut
     FROM routing_events
     WHERE comboName = ? AND timestamp >= ?
       AND cluster IS NOT NULL AND pickedWorker IS NOT NULL
       AND (meta IS NULL OR meta NOT LIKE '%"skippedRouter":true%')
     GROUP BY cluster, pickedWorker`,
    [comboName, since]
  );
}

/** List combo names that have routing events (for scheduler). */
export async function listCombosWithRoutingEvents() {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT DISTINCT comboName FROM routing_events WHERE comboName IS NOT NULL`
  );
  return (rows || []).map((r) => r.comboName).filter(Boolean);
}

export async function getModelPerfStats(comboName, days = 14) {
  const db = await getAdapter();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return db.all(
    `SELECT pickedWorker AS worker,
            COUNT(*) AS n,
            SUM(CASE WHEN outcomeScore >= 60 THEN 1 ELSE 0 END) AS wins,
            AVG(outcomeScore) AS avgScore,
            AVG(workerLatencyMs) AS avgLatencyMs,
            AVG(tokensOut) AS avgTokensOut,
            SUM(CASE WHEN workerStatus >= 400 THEN 1 ELSE 0 END) AS errors
     FROM routing_events
     WHERE comboName = ? AND timestamp >= ? AND pickedWorker IS NOT NULL
       AND (meta IS NULL OR meta NOT LIKE '%"skippedRouter":true%')
     GROUP BY pickedWorker
     ORDER BY avgScore DESC`,
    [comboName, since]
  );
}

/** Mean worker latency grouped by provider for fallback combo preference. */
export async function getProviderLatency(days = 14) {
  const db = await getAdapter();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db.all(
    `SELECT pickedWorker, AVG(workerLatencyMs) AS avgLatencyMs, COUNT(*) AS n
     FROM routing_events
     WHERE timestamp >= ? AND pickedWorker IS NOT NULL AND workerLatencyMs IS NOT NULL
       AND (meta IS NULL OR meta NOT LIKE '%"skippedRouter":true%')
     GROUP BY pickedWorker`,
    [since]
  );
  if (!rows?.length) return {};

  const totals = Object.create(null);
  for (const row of rows) {
    const provider = providerOf(row.pickedWorker);
    const n = Number(row.n) || 0;
    const avgLatencyMs = Number(row.avgLatencyMs);
    if (!Number.isFinite(avgLatencyMs) || n <= 0) continue;
    if (!totals[provider]) totals[provider] = { n: 0, totalLatencyMs: 0 };
    totals[provider].n += n;
    totals[provider].totalLatencyMs += avgLatencyMs * n;
  }

  return Object.fromEntries(
    Object.entries(totals).map(([provider, total]) => [
      provider,
      total.n > 0 ? total.totalLatencyMs / total.n : 0,
    ])
  );
}

export async function getGlobalModelStats(days = 14) {
  const db = await getAdapter();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db.all(
    `SELECT pickedWorker, cluster, COUNT(*) AS n,
            SUM(CASE WHEN outcomeScore >= 60 THEN 1 ELSE 0 END) AS wins,
            AVG(outcomeScore) AS avgScore, AVG(workerLatencyMs) AS avgLatencyMs
     FROM routing_events
     WHERE timestamp >= ? AND pickedWorker IS NOT NULL
       AND (meta LIKE '%"terminal":true%' OR meta IS NULL OR meta NOT LIKE '%"terminal"%')
       AND (meta IS NULL OR meta NOT LIKE '%"skippedRouter":true%')
     GROUP BY pickedWorker, cluster`,
    [since]
  );
  const workers = Object.create(null);
  for (const row of rows || []) {
    const worker = row.pickedWorker;
    const n = Number(row.n) || 0;
    const wins = Number(row.wins) || 0;
    const avgScore = Number(row.avgScore) || 0;
    const avgLatencyMs = Number(row.avgLatencyMs) || 0;
    if (!workers[worker]) {
      workers[worker] = {
        worker,
        n: 0,
        wins: 0,
        totalScore: 0,
        totalLatencyMs: 0,
        clusters: Object.create(null),
      };
    }
    const current = workers[worker];
    current.n += n;
    current.wins += wins;
    current.totalScore += avgScore * n;
    current.totalLatencyMs += avgLatencyMs * n;
    current.clusters[row.cluster] = { n, avgScore };
  }
  return Object.values(workers)
    .map((worker) => ({
      worker: worker.worker,
      n: worker.n,
      wins: worker.wins,
      winRate: worker.n > 0 ? worker.wins / worker.n : 0,
      avgScore: worker.n > 0 ? worker.totalScore / worker.n : 0,
      avgLatencyMs: worker.n > 0 ? worker.totalLatencyMs / worker.n : 0,
      clusters: worker.clusters,
    }))
    .sort((a, b) => b.avgScore - a.avgScore);
}

export async function getComboScoreTimeline(comboName, days = 14) {
  if (!comboName) return [];
  const db = await getAdapter();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db.all(
    `SELECT substr(timestamp, 1, 10) AS day, pickedWorker AS worker,
            COUNT(*) AS n, AVG(outcomeScore) AS avgScore
     FROM routing_events
     WHERE comboName = ? AND timestamp >= ? AND outcomeScore IS NOT NULL
       AND pickedWorker IS NOT NULL
       AND (meta LIKE '%"terminal":true%' OR meta IS NULL OR meta NOT LIKE '%"terminal"%')
       AND (meta IS NULL OR meta NOT LIKE '%"skippedRouter":true%')
     GROUP BY day, worker
     ORDER BY day`,
    [comboName, since]
  );
  return (rows || []).map((row) => ({
    day: row.day,
    worker: row.worker,
    n: Number(row.n) || 0,
    avgScore: Number(row.avgScore) || 0,
  }));
}

/** Terminal, non-skipped rows with an LLM judge result for the selected window. */
export async function getJudgeCoverage(comboName, days = 14) {
  if (!comboName) return { judged: 0, total: 0 };
  const db = await getAdapter();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const row = db.get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN meta LIKE '%"judgeScore":%' THEN 1 ELSE 0 END) AS judged
     FROM routing_events
     WHERE comboName = ? AND timestamp >= ? AND pickedWorker IS NOT NULL
       AND (meta LIKE '%"terminal":true%' OR meta IS NULL OR meta NOT LIKE '%"terminal"%')
       AND (meta IS NULL OR meta NOT LIKE '%"skippedRouter":true%')`,
    [comboName, since]
  );
  return {
    judged: Number(row?.judged) || 0,
    total: Number(row?.total) || 0,
  };
}

export async function getPickSourceCounts(comboName, days = 14) {
  const counts = {
    router: 0,
    bandit_policy: 0,
    cached_route: 0,
    exploration: 0,
    judge_flag_escalation: 0,
    fallback_rescue: 0,
  };
  if (!comboName) return counts;
  const db = await getAdapter();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db.all(
    `SELECT routerReason, fallbackUsed, COUNT(*) AS n
     FROM routing_events
     WHERE comboName = ? AND timestamp >= ? AND pickedWorker IS NOT NULL
       AND (meta LIKE '%"terminal":true%' OR meta IS NULL OR meta NOT LIKE '%"terminal"%')
       AND (meta IS NULL OR meta NOT LIKE '%"skippedRouter":true%')
     GROUP BY routerReason, fallbackUsed`,
    [comboName, since]
  );
  for (const row of rows || []) {
    const n = Number(row.n) || 0;
    let source = "router";
    if (String(row.routerReason).startsWith("exploration")) {
      source = "exploration";
    } else if (row.routerReason === "bandit_policy") {
      source = "bandit_policy";
    } else if (row.routerReason === "cached_route") {
      source = "cached_route";
    } else if (row.routerReason === "judge_flag_escalation") {
      source = "judge_flag_escalation";
    } else if (Number(row.fallbackUsed) === 1) {
      source = "fallback_rescue";
    }
    counts[source] += n;
  }
  return counts;
}

/**
 * Approximate p50 worker latency for a cluster (true percentile from raw samples).
 * Capped sample for hot-path safety.
 */
export async function getClusterLatencyP50(comboName, cluster, days = 14, sampleLimit = 200) {
  if (!comboName || !cluster) return null;
  const db = await getAdapter();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db.all(
    `SELECT workerLatencyMs AS ms FROM routing_events
     WHERE comboName = ? AND cluster = ? AND timestamp >= ?
       AND workerLatencyMs IS NOT NULL
       AND (meta IS NULL OR meta NOT LIKE '%"skippedRouter":true%')
     ORDER BY timestamp DESC LIMIT ?`,
    [comboName, cluster, since, sampleLimit]
  );
  if (!rows?.length) return null;
  const vals = rows.map((r) => Number(r.ms)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!vals.length) return null;
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 === 0 ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid];
}

export async function deleteOldRoutingEvents(days = 90) {
  const db = await getAdapter();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const info = db.run(`DELETE FROM routing_events WHERE timestamp < ?`, [cutoff]);
  notifyWrite(null);
  return info?.changes ?? 0;
}

/** Drop events + learning versions for a combo (rename/delete hygiene). */
export async function deleteRoutingDataForCombo(comboName) {
  if (!comboName) return { events: 0, versions: 0 };
  const db = await getAdapter();
  const ev = db.run(`DELETE FROM routing_events WHERE comboName = ?`, [comboName]);
  const ver = db.run(`DELETE FROM router_learning_versions WHERE comboName = ?`, [comboName]);
  notifyWrite(comboName);
  return { events: ev?.changes ?? 0, versions: ver?.changes ?? 0 };
}

/** Re-key routing rows when a combo is renamed so insights stay attached. */
export async function rekeyRoutingDataForCombo(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  const db = await getAdapter();
  db.transaction(() => {
    db.run(`UPDATE routing_events SET comboName = ? WHERE comboName = ?`, [newName, oldName]);
    db.run(`UPDATE router_learning_versions SET comboName = ? WHERE comboName = ?`, [newName, oldName]);
  });
  notifyWrite(oldName);
  notifyWrite(newName);
}
