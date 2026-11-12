import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { constants, zstdCompressSync } from 'node:zlib';

const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const encodeDshZstd = (header, events) => {
  const headerFrame = zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'), CHECKSUM_OPTIONS);
  if (events.length === 0) return headerFrame;
  const bodyFrame = zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'), CHECKSUM_OPTIONS);
  return Buffer.concat([headerFrame, bodyFrame]);
};

const ROOT = '/Users/humengfan/.dsh/sessions';
const SURFACE = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result']);
const dryRun = process.argv.includes('--dry-run');

// Directories whose session.lock is currently held open by a live DSH process.
const liveLockedDirs = new Set();
try {
  const lsofOut = execFileSync('lsof', ['+D', ROOT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  for (const line of lsofOut.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    const fullPath = parts[parts.length - 1];
    if (fullPath?.endsWith('/session.lock')) liveLockedDirs.add(path.dirname(fullPath));
  }
} catch (err) {
  // lsof on macOS exits 1 when some subdirectories have no open files, while still writing open FDs to stdout.
  const lsofOut = typeof err?.stdout === 'string' ? err.stdout : err?.stdout?.toString?.('utf8') ?? '';
  for (const line of lsofOut.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    const fullPath = parts[parts.length - 1];
    if (fullPath?.endsWith('/session.lock')) liveLockedDirs.add(path.dirname(fullPath));
  }
}

// port of dsh-session-format-v3-to-v4 foldSurface()
function fold(state, event) {
  if (!SURFACE.has(event.type)) return;
  if (event.type === 'system/message' && state.surface.length > 0 && state.protectedHead === undefined)
    throw new Error('system/message requires a protected first surface head');
  if (event.surfaceOp === 'append') {
    if (event.type === 'system/message' && state.surface.length === 0) state.protectedHead = event.seq;
    state.surface.push(event.seq);
    return;
  }
  const op = event.surfaceOp;
  if (typeof op !== 'object' || op === null) throw new Error('bad surfaceOp');
  const first = state.surface.indexOf(op.startSeq);
  const last = state.surface.indexOf(op.endSeq);
  if (first < 0 || last < first) throw new Error('replacement range is not on the current surface');
  const removed = state.surface.slice(first, last + 1);
  const sources = event.sourceEventSeqs ?? [];
  if (removed.some((s) => !sources.includes(s))) throw new Error('replacement sourceEventSeqs omit a shadowed surface node');
  if (state.protectedHead !== undefined && removed.includes(state.protectedHead)) {
    if (event.type !== 'system/message' || removed.length !== 1) throw new Error('surface replacement cannot shadow the protected system head');
    state.protectedHead = event.seq;
  }
  state.surface.splice(first, removed.length, event.seq);
}

// coordinates that may point at a seq we are about to morph (exact keys only)
const REF_KEYS = new Set(["messageSeqs","sourceEventSeqs","shadowedSeqs","startSeq","endSeq","headerSeq","sourceEventSeq"]);
function refsSeq(event, seq) {
  let hit = false;
  const walk = (v) => {
    if (hit || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    for (const [k, x] of Object.entries(v)) {
      if (REF_KEYS.has(k) && (x === seq || (Array.isArray(x) && x.includes(seq)))) hit = true;
      else walk(x);
    }
  };
  walk(event.data);
  if (!hit && event.surfaceOp && typeof event.surfaceOp === "object") {
    for (const k of ["startSeq", "endSeq"]) if (event.surfaceOp[k] === seq) hit = true;
    if ((event.surfaceOp.sourceEventSeqs ?? []).includes(seq)) hit = true;
  }
  return hit;
}

const logs = execFileSync('find', [ROOT, '-name', 'session.v4.jsonl.zstd']).toString().trim().split('\n');
const report = [];
for (const file of logs) {
  let raw;
  try { raw = execFileSync('zstd', ['-d', '-c', file], { maxBuffer: 1 << 28 }); }
  catch { report.push([file, 'ZSTD_FAIL']); continue; }
  const lines = raw.toString('utf8').split('\n').filter(Boolean);
  let events; 
  try { events = lines.map((l) => JSON.parse(l)); }
  catch { report.push([file, 'JSON_FAIL']); continue; }
  const header = events.shift();
  if (header?.type !== 'session') { report.push([file, 'NO_HEADER']); continue; }
  const st = { surface: [], protectedHead: undefined };
  let offender = -1;
  let latent = false;
  try {
    for (const e of events) fold(st, e);
    if (st.surface.length > 0 && st.protectedHead === undefined) {
      // Latent poison: a pre-turn surface record was appended before any system/message existed.
      // As soon as the user sends a message in this draft session, turn 1's system/message will brick it!
      offender = events.length;
      latent = true;
    }
  } catch (err) {
    if (!/protected first surface head/.test(err.message)) { report.push([file, 'OTHER: ' + err.message]); continue; }
    offender = events.findIndex((e) => e.type === 'system/message' && e.surfaceOp === 'append' && st.protectedHead === undefined);
  }
  if (offender < 0) { report.push([file, 'OK']); continue; }
  const candidates = events.slice(0, offender).filter((e) => SURFACE.has(e.type));
  if (candidates.length === 0) { report.push([file, 'POISON_UNKNOWN_SHAPE']); continue; }
  // safety: only repair plain-append logs with no compaction and no coordinate refs to candidates
  const candSeqs = new Set(candidates.map((e) => e.seq));
  let unsafe = events.some((e) => typeof e.surfaceOp === 'object' || String(e.type).startsWith('compaction/'))
    || events.some((e) => !candSeqs.has(e.seq) && candidates.some((c) => refsSeq(e, c.seq)));
  const sessionDir = path.dirname(file);
  const isLocked = liveLockedDirs.has(sessionDir);
  const tag = latent ? 'LATENT' : 'CORRUPT';
  if (unsafe) { report.push([file, `POISON_COMPLEX_${tag}(${candidates.length} pre-head records) — not touched`]); continue; }
  if (isLocked) { report.push([file, `POISON_LOCKED_${tag}(${candidates.length}) — quit app, then rerun repair`]); continue; }
  if (dryRun) { report.push([file, `WOULD_REPAIR_${tag}(${candidates.length} pre-head records)`]); continue; }
  fs.copyFileSync(file, file + '.corrupt-bak');
  for (const c of candidates) { c.type = 'plugin/style-announce'; c.ignorable = true; }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, encodeDshZstd(header, events), { mode: 0o600 });
  fs.renameSync(tmp, file);
  // Drop stale session_projcache entry if present so DSH rebuilds projections cleanly on next open.
  const projCacheFile = path.join('/Users/humengfan/.dsh/storages/session_projcache/sessions', `${header.id}.json`);
  try { fs.unlinkSync(projCacheFile); } catch {}
  report.push([file, `REPAIRED_${tag}(${candidates.length} morphed, backup .corrupt-bak)`]);
}
for (const [f, r] of report) console.log(r.padEnd(60), path.basename(path.dirname(f)), path.basename(path.dirname(path.dirname(f))).slice(0, 40));
