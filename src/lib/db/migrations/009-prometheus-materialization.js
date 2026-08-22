const METRIC_FIELDS = ["requests", "promptTokens", "completionTokens", "cachedTokens", "cost"];
const AUTO_SOURCES = [
  "router",
  "bandit_policy",
  "cached_route",
  "exploration",
  "judge_flag_escalation",
  "fallback_rescue",
];

function tableExists(db, name) {
  return Boolean(db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]));
}

function emptyUsage(provider) {
  return { provider, requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
}

function metricValue(value, context) {
  if (value == null) return 0;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`invalid Prometheus aggregate value: ${context}`);
  }
  return number;
}

function addUsage(target, values, context) {
  for (const field of METRIC_FIELDS) {
    target[field] += metricValue(values?.[field], `${context}.${field}`);
  }
}

function backfillUsage(db) {
  const configured = new Set(
    (tableExists(db, "providerConnections")
      ? db.all("SELECT DISTINCT provider FROM providerConnections") || []
      : [])
      .map((row) => String(row.provider || ""))
      .filter(Boolean),
  );
  const totals = new Map();
  const totalFor = (provider) => {
    if (!totals.has(provider)) totals.set(provider, emptyUsage(provider));
    return totals.get(provider);
  };
  const dailyRows = tableExists(db, "usageDaily")
    ? db.all("SELECT dateKey, data FROM usageDaily") || []
    : [];

  for (const row of dailyRows) {
    let day;
    try {
      day = JSON.parse(row.data);
    } catch {
      throw new Error(`invalid Prometheus usage aggregate JSON: ${row.dateKey}`);
    }
    if (!day || typeof day !== "object" || Array.isArray(day)) {
      throw new Error(`invalid Prometheus usage aggregate object: ${row.dateKey}`);
    }
    const overall = emptyUsage("overall");
    addUsage(overall, day, `usageDaily.${row.dateKey}`);
    if (day.byProvider != null && (typeof day.byProvider !== "object" || Array.isArray(day.byProvider))) {
      throw new Error(`invalid Prometheus provider aggregate: ${row.dateKey}`);
    }
    const attributed = emptyUsage("attributed");
    for (const [rawProvider, values] of Object.entries(day.byProvider || {})) {
      if (!values || typeof values !== "object" || Array.isArray(values)) {
        throw new Error(`invalid Prometheus provider aggregate: ${row.dateKey}.${rawProvider}`);
      }
      addUsage(attributed, values, `usageDaily.${row.dateKey}.byProvider.${rawProvider}`);
      const provider = configured.has(rawProvider) ? rawProvider : "unknown";
      addUsage(totalFor(provider), values, `usageDaily.${row.dateKey}.byProvider.${rawProvider}`);
    }
    const unknown = totalFor("unknown");
    for (const field of METRIC_FIELDS) {
      const remainder = overall[field] - attributed[field];
      if (remainder < -1e-9) {
        throw new Error(`invalid Prometheus usage remainder: ${row.dateKey}.${field}`);
      }
      unknown[field] += Math.max(0, remainder);
    }
  }

  for (const total of totals.values()) {
    if (!METRIC_FIELDS.some((field) => total[field] > 0)) continue;
    db.run(
      `INSERT INTO prometheusUsageTotals(provider, requests, promptTokens, completionTokens, cachedTokens, cost)
       VALUES(?, ?, ?, ?, ?, ?)`,
      [total.provider, total.requests, total.promptTokens, total.completionTokens, total.cachedTokens, total.cost],
    );
  }
}

function backfillRouting(db) {
  const rows = tableExists(db, "routing_events")
    ? db.all(
      `WITH terminal AS (
         SELECT id,
                COALESCE(requestId, CAST(id AS TEXT)) AS requestKey,
                comboName,
                timestamp,
                routerReason,
                fallbackUsed,
                workerStatus
         FROM routing_events
         WHERE (
           meta LIKE '%"terminal":true%'
           OR meta IS NULL
           OR meta NOT LIKE '%"terminal"%'
         )
           AND (meta IS NULL OR meta NOT LIKE '%"skippedRouter":true%')
       ),
       per_request AS (
         SELECT requestKey,
                MAX(id) AS terminalId,
                MAX(CASE WHEN fallbackUsed = 1 THEN 1 ELSE 0 END) AS fallbackUsed,
                MAX(CASE WHEN workerStatus >= 400 THEN 1 ELSE 0 END) AS isError
         FROM terminal
         GROUP BY requestKey
       )
       SELECT per_request.requestKey,
              terminal.comboName,
              terminal.timestamp,
              per_request.terminalId,
              CASE
                WHEN terminal.routerReason LIKE 'exploration%' THEN 'exploration'
                WHEN terminal.routerReason = 'bandit_policy' THEN 'bandit_policy'
                WHEN terminal.routerReason = 'cached_route' THEN 'cached_route'
                WHEN terminal.routerReason = 'judge_flag_escalation' THEN 'judge_flag_escalation'
                WHEN per_request.fallbackUsed = 1 THEN 'fallback_rescue'
                ELSE 'router'
              END AS source,
              per_request.isError,
              per_request.fallbackUsed
       FROM per_request
       JOIN terminal ON terminal.id = per_request.terminalId`,
    ) || []
    : [];

  const totals = Object.fromEntries(AUTO_SOURCES.map((source) => [source, { requests: 0, errors: 0, fallbacks: 0 }]));
  for (const row of rows) {
    db.run(
      `INSERT INTO prometheusRoutingRequests(requestKey, comboName, timestamp, terminalId, source, isError, fallbackUsed)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [row.requestKey, row.comboName, row.timestamp, row.terminalId, row.source, row.isError, row.fallbackUsed],
    );
    totals[row.source].requests += 1;
    totals[row.source].errors += Number(row.isError) || 0;
    totals[row.source].fallbacks += Number(row.fallbackUsed) || 0;
  }
  for (const source of AUTO_SOURCES) {
    const total = totals[source];
    db.run(
      `INSERT INTO prometheusRoutingTotals(source, requests, errors, fallbacks) VALUES(?, ?, ?, ?)`,
      [source, total.requests, total.errors, total.fallbacks],
    );
  }
}

const migration = {
  version: 9,
  name: "prometheus-materialization",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS prometheusUsageTotals (
        provider TEXT PRIMARY KEY,
        requests INTEGER NOT NULL,
        promptTokens INTEGER NOT NULL,
        completionTokens INTEGER NOT NULL,
        cachedTokens INTEGER NOT NULL,
        cost REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS prometheusRoutingRequests (
        requestKey TEXT PRIMARY KEY,
        comboName TEXT,
        timestamp TEXT NOT NULL,
        terminalId INTEGER NOT NULL,
        source TEXT NOT NULL,
        isError INTEGER NOT NULL,
        fallbackUsed INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_prom_routing_combo ON prometheusRoutingRequests(comboName);
      CREATE INDEX IF NOT EXISTS idx_prom_routing_timestamp ON prometheusRoutingRequests(timestamp);
      CREATE TABLE IF NOT EXISTS prometheusRoutingTotals (
        source TEXT PRIMARY KEY,
        requests INTEGER NOT NULL,
        errors INTEGER NOT NULL,
        fallbacks INTEGER NOT NULL
      );
      DELETE FROM prometheusUsageTotals;
      DELETE FROM prometheusRoutingRequests;
      DELETE FROM prometheusRoutingTotals;
    `);
    backfillUsage(db);
    backfillRouting(db);
  },
  down(db) {
    db.exec(`
      DROP TABLE IF EXISTS prometheusRoutingTotals;
      DROP TABLE IF EXISTS prometheusRoutingRequests;
      DROP TABLE IF EXISTS prometheusUsageTotals;
    `);
  },
};

export default migration;
