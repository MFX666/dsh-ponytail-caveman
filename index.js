/**
 * Session Prompts — Host plugin.
 *
 * Injects working-style prompts into every session's system prompt, the DSH
 * equivalent of a SessionStart hook in other agent harnesses. Inspired by:
 * - ponytail   (https://github.com/DietrichGebert/ponytail)  — "lazy senior dev": solve the
 *   whole problem with the least new code.
 * - pi-caveman (https://github.com/jonjonrankin/pi-caveman) — "caveman": terse output that
 *   keeps technical substance while cutting filler tokens.
 *
 * Mechanism: two layers.
 * - `ctx.systemPrompt.section()` registers ordered sections, so the text is
 *   re-assembled into every model request of every agent (root sessions and
 *   subagents alike) and survives compaction.
 * - An `agent/created` listener commits a visible `user/message` at session
 *   start (fresh creation, clear, compaction — not resume, where the earlier
 *   message is already durable), so the injection appears in the session
 *   trajectory. If that append is rejected, it degrades to `agent.inject()`,
 *   which is durable but transcript-invisible.
 * A level change in the profile patch restarts the plugin and applies to
 * existing and future sessions without restart.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';

const name = 'dsh-ponytail-caveman';
const inject = ['systemPrompt', 'webServer', 'configEditor'];

const ROUTE_PREFIX = '/api/dsh-ponytail-caveman/';
const LEVELS = new Set(['off', 'lite', 'full', 'ultra']);
const MAX_TEXT_CHARS = 20000;

/** Section placement: after deployment persona (0), before plan policy (500). */
const STYLE_SECTION_ORDER = 450;

export const Config = z.object({
  ponytail: z
    .union([z.const('off'), z.const('lite'), z.const('full'), z.const('ultra')])
    .default('full')
    .description('Lazy senior dev mode: solve the whole problem with the least new code. off disables it.'),
  caveman: z
    .union([z.const('off'), z.const('lite'), z.const('full'), z.const('ultra')])
    .default('off')
    .description('Caveman mode: terse output that keeps technical substance and cuts filler tokens. off disables it.'),
  ponytailText: z
    .string()
    .default('')
    .description('Optional custom ponytail rules; empty uses the built-in text of the chosen level.'),
  cavemanText: z
    .string()
    .default('')
    .description('Optional custom caveman rules; empty uses the built-in text of the chosen level.'),
}).description('Working-style prompts injected into every session system prompt.');

const PONYTAIL_LITE = `SESSION STYLE: PONYTAIL (lazy senior dev) — level: lite
You are a lazy senior developer: the best code is the code never written. Solve the whole problem with the least new code.
Preference ladder — take the first option that fully works: (1) skip anything nobody asked for; (2) reuse what this codebase already has; (3) standard library or platform feature; (4) an already-installed dependency; (5) a one-liner; (6) otherwise the minimum code that works.
Be lazy about the solution, never about the change: finish every part the task needs, including the callers and tests your change affects. When you finish, name in one or two lines what you skipped and any risk the user should know.`;

const PONYTAIL_FULL = `SESSION STYLE: PONYTAIL (lazy senior dev) — level: full
You are a lazy senior developer. The best code is the code never written. You solve the whole problem with the least new code, and you finish every part of what you take on.

Before you write: read the task and the code it touches. List every place the change must reach — callers, tests, fixtures, config, exports — and check what it could break for users. That is the scope. Extra features are not.

The smallest complete change — take the first option that fully works:
1. Does it need to exist? Skip features, options, and flexibility nobody asked for; name them in one line. A vague request gets the smallest version that does the core job.
2. Already in this codebase (a helper, component, service, pattern)? Use it the way the surrounding code does.
3. Standard library or platform feature? Use it, unless the project has its own.
4. Installed dependency? Use it. Never add a dependency for a few lines.
5. Can it be one line a reader gets at a glance? One line.
6. Otherwise: the minimum code that works.

Rules: no abstraction, wrapper, option, config, boilerplate, or "for later" code nobody asked for. Deletion beats addition. Keep the structure, layers, and conventions the codebase already has. The shortest working diff wins, once you know everything it must touch. Comment only the why the code cannot show, in one line. For a bug fix, check every caller of what you touch, then fix the root cause once in the shared code. New non-trivial logic (a branch, loop, parser, money or security path, a new script) leaves one small test or an assert-based self-check. A shortcut with a known limit gets a one-line comment: \`shortcut: <the limit>, <when to upgrade>\`.

Never cut: validation at trust boundaries, error handling that prevents data loss, security, accessibility, anything the user asked for.
End your reply with one or two lines: what you skipped or did not check, and any risk the user must know.`;

const PONYTAIL_ULTRA = `${PONYTAIL_FULL}

Ultra additions:
- Before proposing anything new, scan the target area first and name the existing pieces you will reuse. If you cannot name them, look before you write.
- Between options of equal size, take the one that is correct on edge cases.
- Refuse speculative generality out loud: when a request asks for flexibility nobody needs, say so in one line and build the concrete version.
- If the honest fix is deletion, propose deletion first.`;

const CAVEMAN_SAFETY = `Safety override: for security warnings, irreversible or destructive actions, exact error text the user must copy, or when the user seems confused, drop this style and answer in full natural language.`;

const CAVEMAN_LITE = `OUTPUT STYLE: CAVEMAN — level: lite
Be terse like a smart caveman, but keep full sentences. Drop filler ("just", "really", "basically"), pleasantries, hedging, and restating the request. Keep every technical fact intact: file paths, commands, code blocks unchanged; quote errors exactly. Prefer short synonyms; keep technical terms exact.
${CAVEMAN_SAFETY}`;

const CAVEMAN_FULL = `OUTPUT STYLE: CAVEMAN — level: full
Answer like a smart caveman: maximum substance, minimum words. Sentence fragments are fine. Drop articles (a/an/the), filler, pleasantries, and hedging. Follow the pattern: [thing] [action] [reason]. [next step]. Keep all technical detail intact: commands and code blocks unchanged; quote errors exactly. Prefer shorter words; keep technical terms exact.
${CAVEMAN_SAFETY}`;

const CAVEMAN_ULTRA = `OUTPUT STYLE: CAVEMAN — level: ultra
Same rules as full caveman, plus compress harder: use "->" for causality and sequence; abbreviate where unambiguous (cfg, impl, repo, deps, env); never restate the question or narrate plans; one line per idea; lists over paragraphs.
${CAVEMAN_SAFETY}`;

const PONYTAIL_PROMPTS = { lite: PONYTAIL_LITE, full: PONYTAIL_FULL, ultra: PONYTAIL_ULTRA };
const CAVEMAN_PROMPTS = { lite: CAVEMAN_LITE, full: CAVEMAN_FULL, ultra: CAVEMAN_ULTRA };

/** Session-start sources that (re-)announce the style message; `resume` is skipped because the earlier message is still durable in the log. */
const ANNOUNCE_SOURCES = new Set(['startup', 'clear', 'compaction']);

/** Read one JSON request body with a size guard. */
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 1_000_000) { reject(new Error('body too large')); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};

export function apply(ctx, config) {
  // `off` disables the mode entirely; custom non-empty text overrides the level's built-in text.
  const rulesText = (level, customText, builtIn) => {
    if (level === 'off') return false;
    if (customText.trim() !== '') return customText;
    return builtIn[level] ?? builtIn.full;
  };
  const styleText = [
    rulesText(config.ponytail, config.ponytailText ?? '', PONYTAIL_PROMPTS),
    rulesText(config.caveman, config.cavemanText ?? '', CAVEMAN_PROMPTS),
  ].filter(Boolean).join('\n\n');
  if (styleText !== '') {
    ctx.effect(
      () => ctx.systemPrompt.section({ name: `${name}:style`, order: STYLE_SECTION_ORDER, text: styleText }),
      `register system prompt section ${name}:style`,
    );
  }
  if (styleText === '') return;
  ctx.effect(
    () => ctx.on('agent/created', ({ agent, source }) => {
      if (!ANNOUNCE_SOURCES.has(source)) return;
      const message = createUserMessage({
        content: [{
          type: 'text',
          text: `Session style instructions (injected by the "${name}" plugin; they apply to this whole session):\n\n${styleText}`,
        }],
        source: { kind: name },
      });
      try {
        agent.session.append('user/message', message, { surfaceOp: 'append' });
      } catch {
        // session append rejected (format/policy change): keep the rules durable but transcript-invisible
        agent.inject(message);
      }
    }),
    `announce ${name} style on agent/created`,
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const admission = ctx.connection.admit(req);
        if ('rejection' in admission) {
          res.writeHead(admission.rejection);
          res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden');
          return;
        }
        try {
          const url = new URL(req.url, 'http://local');
          if (req.method === 'GET' && url.pathname === `${ROUTE_PREFIX}config`) {
            return json(res, 200, {
              ponytail: config.ponytail,
              caveman: config.caveman,
              ponytailText: config.ponytailText ?? '',
              cavemanText: config.cavemanText ?? '',
            });
          }
          if (req.method === 'POST' && url.pathname === `${ROUTE_PREFIX}config`) {
            const body = JSON.parse((await readBody(req)) || '{}');
            const patch = {};
            for (const key of ['ponytail', 'caveman']) {
              if (body[key] !== undefined) {
                if (!LEVELS.has(body[key])) throw new Error(`${key} must be one of off/lite/full/ultra`);
                patch[key] = body[key];
              }
            }
            for (const key of ['ponytailText', 'cavemanText']) {
              if (body[key] !== undefined) {
                if (typeof body[key] !== 'string' || body[key].length > MAX_TEXT_CHARS) throw new Error(`${key} must be a string of at most ${MAX_TEXT_CHARS} characters`);
                patch[key] = body[key];
              }
            }
            const entry = ctx.fiber.entry;
            const editor = ctx.get('configEditor');
            if (entry === undefined || editor === undefined) throw new Error('configuration cannot be saved in this profile');
            await editor.edit(entry, (current) => ({ ...current, ...patch }));
            return json(res, 200, { saved: true, ...patch });
          }
          json(res, 404, { error: 'not found' });
        } catch (error) {
          json(res, 400, { error: String(error?.message ?? error) });
        }
      },
    }),
    'register config routes',
  );
}

export { name, inject };
