import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { constants, zstdCompressSync } from 'node:zlib';
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const file = process.argv[2];
const raw = execFileSync('zstd', ['-d', '-c', file], { maxBuffer: 1 << 28 }).toString('utf8');
const all = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const header = all.shift();
const events = all;
const SURFACE = new Set(['system/message','user/message','developer/message','assistant/message','tool/result']);
function fold(st, e) {
  if (!SURFACE.has(e.type)) return;
  if (e.type === 'system/message' && st.surface.length > 0 && st.protectedHead === undefined) throw new Error('protected head');
  if (e.surfaceOp === 'append') {
    if (e.type === 'system/message' && st.surface.length === 0) st.protectedHead = e.seq;
    st.surface.push(e.seq); return;
  }
  const op = e.surfaceOp;
  const first = st.surface.indexOf(op.startSeq), last = st.surface.indexOf(op.endSeq);
  if (first < 0 || last < first) throw new Error('replacement range off surface');
  const removed = st.surface.slice(first, last + 1);
  if (removed.some((s) => !(e.sourceEventSeqs ?? []).includes(s))) throw new Error('sourceEventSeqs omit node');
  if (st.protectedHead !== undefined && removed.includes(st.protectedHead)) {
    if (e.type !== 'system/message' || removed.length !== 1) throw new Error('shadows protected head');
    st.protectedHead = e.seq;
  }
  st.surface.splice(first, removed.length, e.seq);
}
// pass 1: find offender
const st0 = { surface: [], protectedHead: undefined };
try { for (const e of events) fold(st0, e); console.log('already OK'); process.exit(0); }
catch (err) { if (!/protected head/.test(err.message)) throw err; }
const firstSys = events.findIndex((e) => e.type === 'system/message' && st0.protectedHead === undefined && e.surfaceOp === 'append');
const cands = events.slice(0, firstSys).filter((e) => SURFACE.has(e.type));
const candSeqs = new Set(cands.map((e) => e.seq));
const REF_KEYS = new Set(['messageSeqs','sourceEventSeqs','shadowedSeqs','startSeq','endSeq','headerSeq','sourceEventSeq']);
let refd = false;
const walk = (v) => {
  if (refd || v === null || typeof v !== 'object') return;
  if (Array.isArray(v)) { v.forEach(walk); return; }
  for (const [k, x] of Object.entries(v)) {
    if (REF_KEYS.has(k) && (x === undefined || x === candSeqs.has ? false : undefined)) {}
    if (REF_KEYS.has(k)) { const hit = x === undefined ? false : (Array.isArray(x) ? x.some((n) => candSeqs.has(n)) : candSeqs.has(x)); if (hit) refd = true; }
    else walk(x);
  }
};
events.forEach((e) => { walk(e.data); walk({ sourceEventSeqs: e.sourceEventSeqs }); });
if (refd) { console.log('candidate seq referenced elsewhere — abort'); process.exit(1); }
for (const c of cands) { c.type = 'plugin/style-announce'; c.ignorable = true; }
// pass 2: full re-sim
const st1 = { surface: [], protectedHead: undefined };
for (const e of events) fold(st1, e);
events.forEach((e, i) => { if (e.seq !== i) throw new Error('density broken'); if (!knownish(e.type) && e.ignorable !== true) throw new Error('unknown type not ignorable'); });
function knownish(t) { return SURFACE.has(t) || /^(session|permission|sandbox|approval|turn|step|request|tool|agent|job|workspace|llm|compaction|subagent|assistant|model)/.test(t); }
fs.copyFileSync(file, file + '.corrupt-bak');
const headerFrame = zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'), CHECKSUM_OPTIONS);
const bodyFrame = events.length === 0
  ? Buffer.alloc(0)
  : zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'), CHECKSUM_OPTIONS);
fs.writeFileSync(file + '.tmp', Buffer.concat([headerFrame, bodyFrame]), { mode: 0o600 });
fs.renameSync(file + '.tmp', file);
console.log('REPAIRED one-off:', cands.length, 'morphed');
