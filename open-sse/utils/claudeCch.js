// @ts-check
/**
 * Claude Code CCH request signing (2.1.220+ wire shape).
 *
 * Port of CLIProxyAPI's claude_signing.go: the billing block carried as
 * system[0] ends in `cch=xxxxx;` — five hex digits of
 * xxHash64(normalizedBody, 0x4D659218E32A3268) & 0xFFFFF. The hash view is
 * the FINAL serialized body with cch zeroed, every "model" string value
 * emptied, and the dispatch members (max_tokens, fallbacks,
 * fallback_credit_token) removed — no JSON reserialization, byte-exact.
 *
 * A real Claude OAuth client always signs (first-party base URLs); Anthropic
 * treats an unsigned or wrongly-signed billing block as a non-native client.
 * All byte offsets are computed on the UTF-8 buffer, never on JS string
 * indices, so multibyte content hashes identically to the Go implementation.
 */

const CCH_SEED = 0x4D659218E32A3268n;
const CCH_LENGTH = 5;
const EXCLUDED_KEYS = new Set(['"max_tokens"', '"fallbacks"', '"fallback_credit_token"']); // quoted JSON key tokens, byte-exact

// ── xxHash64 ───────────────────────────────────────────────────────────────
const P1 = 11400714785074694791n;
const P2 = 14029467366897019727n;
const P3 = 1609587929392839161n;
const P4 = 9650029242287828579n;
const P5 = 2870177450012600261n;
const MASK = 0xffffffffn;

function rotl(x, r) {
  return ((x << r) | (x >> (64n - r))) & 0xffffffffffffffffn;
}

function roundFn(acc, input) {
  acc = (acc + input * P2) & 0xffffffffffffffffn;
  acc = rotl(acc, 31n);
  return (acc * P1) & 0xffffffffffffffffn;
}

function mergeRound(acc, val) {
  val = roundFn(0n, val);
  acc ^= val;
  acc = (acc * P1 + P4) & 0xffffffffffffffffn;
  return acc;
}

function readU64(buf, off) {
  let v = 0n;
  for (let i = 7; i >= 0; i -= 1) v = (v << 8n) | BigInt(buf[off + i]);
  return v;
}

function readU32(buf, off) {
  return (BigInt(buf[off]) | (BigInt(buf[off + 1]) << 8n) | (BigInt(buf[off + 2]) << 16n) | (BigInt(buf[off + 3]) << 24n)) & MASK;
}

/** @param {Buffer} buf @param {bigint} seed */
export function xxHash64(buf, seed = 0n) {
  const n = buf.length;
  let h;
  let pos = 0;
  if (n >= 32) {
    let v1 = (seed + P1 + P2) & 0xffffffffffffffffn;
    let v2 = (seed + P2) & 0xffffffffffffffffn;
    let v3 = seed;
    let v4 = (seed - P1) & 0xffffffffffffffffn;
    while (pos + 32 <= n) {
      v1 = roundFn(v1, readU64(buf, pos)); pos += 8;
      v2 = roundFn(v2, readU64(buf, pos)); pos += 8;
      v3 = roundFn(v3, readU64(buf, pos)); pos += 8;
      v4 = roundFn(v4, readU64(buf, pos)); pos += 8;
    }
    h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & 0xffffffffffffffffn;
    h = mergeRound(h, v1);
    h = mergeRound(h, v2);
    h = mergeRound(h, v3);
    h = mergeRound(h, v4);
  } else {
    h = (seed + P5) & 0xffffffffffffffffn;
  }
  h = (h + BigInt(n)) & 0xffffffffffffffffn;
  while (pos + 8 <= n) {
    h ^= roundFn(0n, readU64(buf, pos));
    h = (rotl(h, 27n) * P1 + P4) & 0xffffffffffffffffn;
    pos += 8;
  }
  if (pos + 4 <= n) {
    h ^= (readU32(buf, pos) * P1) & 0xffffffffffffffffn;
    h = (rotl(h, 23n) * P2 + P3) & 0xffffffffffffffffn;
    pos += 4;
  }
  while (pos < n) {
    h ^= (BigInt(buf[pos]) * P5) & 0xffffffffffffffffn;
    h = (rotl(h, 11n) * P1) & 0xffffffffffffffffn;
    pos += 1;
  }
  h ^= h >> 33n;
  h = (h * P2) & 0xffffffffffffffffn;
  h ^= h >> 29n;
  h = (h * P3) & 0xffffffffffffffffn;
  h ^= h >> 32n;
  return h;
}

// ── Hash-view normalizer (byte-exact port of claudeCCHJSONScanner) ─────────
class Scanner {
  /** @param {Buffer} body */
  constructor(body) {
    this.body = body;
    this.pos = 0;
    /** @type {{start: number, end: number}[]} */
    this.edits = [];
  }

  addEdit(start, end) {
    if (start >= end) return;
    this.edits.push({ start, end });
  }

  skipWhitespace() {
    while (this.pos < this.body.length) {
      const c = this.body[this.pos];
      if (c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a) this.pos += 1;
      else return;
    }
  }

  consume(character) {
    if (this.pos >= this.body.length || this.body[this.pos] !== character) return false;
    this.pos += 1;
    return true;
  }

  parseString() {
    // body[this.pos] is '"' — returns [start, end) of the quoted token.
    const start = this.pos;
    this.pos += 1;
    while (this.pos < this.body.length) {
      const c = this.body[this.pos];
      if (c === 0x5c) { this.pos += 2; continue; } // backslash escape
      this.pos += 1;
      if (c === 0x22) return [start, this.pos];
    }
    throw new Error(`unterminated JSON string at byte ${start}`);
  }

  parseValue(collect) {
    this.skipWhitespace();
    if (this.pos >= this.body.length) throw new Error(`missing JSON value at byte ${this.pos}`);
    const c = this.body[this.pos];
    if (c === 0x7b) return this.parseObject(collect);
    if (c === 0x5b) return this.parseArray(collect);
    if (c === 0x22) { this.parseString(); return; }
    const start = this.pos;
    while (this.pos < this.body.length) {
      const d = this.body[this.pos];
      if (d === 0x2c || d === 0x7d || d === 0x5d || d === 0x20 || d === 0x09 || d === 0x0d || d === 0x0a) {
        if (this.pos === start) throw new Error(`missing JSON value at byte ${start}`);
        return;
      }
      this.pos += 1;
    }
    if (this.pos === start) throw new Error(`missing JSON value at byte ${start}`);
  }

  parseObject(collect) {
    this.pos += 1;
    this.skipWhitespace();
    if (this.consume(0x7d)) return;

    const members = [];
    let commaBefore = -1;
    for (;;) {
      this.skipWhitespace();
      const memberStart = this.pos;
      const [keyStart, keyEnd] = this.parseString();
      this.skipWhitespace();
      if (!this.consume(0x3a)) throw new Error(`missing object colon at byte ${this.pos}`);
      this.skipWhitespace();

      const key = this.body.toString("utf8", keyStart, keyEnd);
      const excluded = collect && EXCLUDED_KEYS.has(key);
      if (collect && key === '"model"' && this.pos < this.body.length && this.body[this.pos] === 0x22) {
        const [valueStart, valueEnd] = this.parseString();
        this.addEdit(valueStart + 1, valueEnd - 1);
      } else {
        this.parseValue(collect && !excluded);
      }
      const memberEnd = this.pos;
      this.skipWhitespace();

      let commaAfter = -1;
      if (this.consume(0x2c)) commaAfter = this.pos - 1;
      members.push({ start: memberStart, end: memberEnd, commaBefore, commaAfter, excluded });
      if (commaAfter >= 0) { commaBefore = commaAfter; continue; }
      if (!this.consume(0x7d)) throw new Error(`missing object end at byte ${this.pos}`);
      break;
    }

    if (collect) this.addExcludedMemberEdits(members);
  }

  parseArray(collect) {
    this.pos += 1;
    this.skipWhitespace();
    if (this.consume(0x5d)) return;
    for (;;) {
      this.parseValue(collect);
      this.skipWhitespace();
      if (this.consume(0x2c)) continue;
      if (!this.consume(0x5d)) throw new Error(`missing array end at byte ${this.pos}`);
      return;
    }
  }

  addExcludedMemberEdits(members) {
    for (let start = 0; start < members.length;) {
      if (!members[start].excluded) { start += 1; continue; }
      let end = start;
      while (end + 1 < members.length && members[end + 1].excluded) end += 1;
      if (end + 1 < members.length) {
        this.addEdit(members[start].start, members[end].commaAfter + 1);
      } else if (start > 0 && end > start) {
        // Claude Code 2.1.220 leaves the preceding comma in its hash view when
        // an object ends with multiple consecutive dispatch members.
        this.addEdit(members[start].start, members[end].end);
      } else if (start > 0) {
        this.addEdit(members[start].commaBefore, members[end].end);
      } else {
        this.addEdit(members[start].start, members[end].end);
      }
      start = end + 1;
    }
  }
}

/** Build the hash view of the serialized body (no reserialization). */
function normalizeCchInput(body) {
  const scanner = new Scanner(body);
  scanner.parseValue(true);
  scanner.skipWhitespace();
  if (scanner.pos !== body.length) throw new Error(`unexpected JSON data at byte ${scanner.pos}`);
  scanner.edits.sort((a, b) => a.start - b.start);
  const chunks = [];
  let last = 0;
  for (const edit of scanner.edits) {
    if (edit.start < last || edit.end > body.length) throw new Error(`overlapping CCH normalization edit at byte ${edit.start}`);
    chunks.push(body.subarray(last, edit.start));
    last = edit.end;
  }
  chunks.push(body.subarray(last));
  return Buffer.concat(chunks);
}

/**
 * Locate the five cch digits inside the billing block carried as system[0].
 * Returns [start, end) byte offsets of the digits, or null. The billing text
 * (cc_version=…; cc_entrypoint=…; cch=…;) contains no JSON-escapable
 * characters, so its escaped form equals its raw form — a direct buffer
 * search is byte-exact.
 * @param {Buffer} body
 */
function cchDigitsOffset(body) {
  const billingIdx = body.indexOf("x-anthropic-billing-header:");
  if (billingIdx < 0) return null;
  const cchIdx = body.indexOf("cch=", billingIdx);
  if (cchIdx < 0 || cchIdx - billingIdx > 256) return null;
  for (let i = 0; i < CCH_LENGTH; i += 1) {
    const c = body[cchIdx + 4 + i];
    const isLowerHex = (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66);
    if (!isLowerHex) return null;
  }
  if (body[cchIdx + 4 + CCH_LENGTH] !== 0x3b) return null; // ';'
  return [cchIdx + 4, cchIdx + 4 + CCH_LENGTH];
}

/**
 * Sign a serialized Anthropic Messages body: zero the cch digits, hash the
 * normalized view, patch the real digits in. Returns the signed Buffer.
 * @param {string|Buffer} bodyStr
 * @returns {Buffer}
 */
export function signClaudeBodyCch(bodyStr) {
  const body = Buffer.isBuffer(bodyStr) ? bodyStr : Buffer.from(bodyStr, "utf8");
  const offsets = cchDigitsOffset(body);
  if (!offsets) return body;
  const [start, end] = offsets;
  const unsigned = Buffer.from(body);
  unsigned.fill(0x30, start, end); // "00000"

  const normalized = normalizeCchInput(unsigned);
  const cch = (xxHash64(normalized, CCH_SEED) & 0xfffffn).toString(16).padStart(CCH_LENGTH, "0");
  unsigned.write(cch, start, CCH_LENGTH, "ascii");
  return unsigned;
}
