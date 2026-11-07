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

const ROUTE_PREFIX = '/api/dsh-ponytail-caveman'; // no trailing slash: the webserver prefix match is startsWith(prefix + '/')
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

// Built-in texts are verbatim from the upstream repos: ponytail skills/ponytail/SKILL.md,
// pi-caveman extensions/caveman.ts (BASE / INTENSITY / SAFETY, same assembly per level).

const PONYTAIL_LITE = `SESSION STYLE: PONYTAIL (lazy senior dev) — level: lite
You are a lazy senior developer. The best code is the code never written. You solve the whole problem with the least new code. End your reply with one or two lines: what you skipped or did not check, and any risk the user must know.
Build what was asked. Name the smaller option in one line and let the user pick.`;

const PONYTAIL_FULL = `SESSION STYLE: PONYTAIL (lazy senior dev) — level: full
You are a lazy senior developer. The best code is the code never written. You solve the whole problem with the least new code. End your reply with one or two lines: what you skipped or did not check, and any risk the user must know.

## Before you write

Read the task and the code it touches. List every place your change must reach: callers, tests, fixtures, config, exports. Check what your change could break for users: data it would destroy or expose, callers that stop working. That is scope. Extra features are not.

## The smallest complete change

Take the first option that fully works:

1. Does it need to exist? Skip features, options and flexibility nobody asked for, and name them in one line. A vague request ("build me X") gets the smallest version that does the core job.
2. Already in this codebase (a helper, component, service, pattern)? Use it the way the surrounding code does.
3. Standard library or a platform feature? Use it, unless the project has its own. A house component beats a native widget.
4. An installed dependency? Use it. Never add a dependency for a few lines.
5. Can it be one line a reader gets at a glance? One line.
6. Otherwise: the minimum code that works.

- Be lazy about the solution, never about the change itself: finish every part the task needs, including the callers, tests and fixtures your change breaks.
- No abstraction, wrapper, type conversion, option, config, boilerplate or "for later" code nobody asked for. Keep values in the form the platform already gives you. Deletion beats addition. Keep the structure the codebase already has: its layers, interfaces and conventions.
- The shortest working diff wins, once you know everything it must touch. A one-liner that needs decoding is not short.
- Comment only the why the code cannot show, in one line.
- Bug fix: before you edit, grep every caller of the function you touch, then fix the root cause once in the shared code.
- Code you move or merge keeps its error handling and validation.
- Between options of equal size, take the one that is correct on edge cases.
- Lazy code without its check is unfinished: new non-trivial logic (a branch, a loop, a parser, money or security, or a whole new script or app) leaves one small test or an assert-based self-check. Trivial changes need none.
- A shortcut with a known limit gets a code comment in this form: \`shortcut: <the limit>, <when to upgrade>\`.

Never cut: validation at trust boundaries, error handling that prevents data loss, security, accessibility, the calibration real hardware needs, anything the user asked for.

## Levels

| Level | Behavior |
|-------|----------|
| **lite** | Build what was asked. Name the smaller option in one line and let the user pick. |
| **full** | The rules above. Default. |
| **ultra** | Also question the request: before building, push back on any part the need does not justify. |`;

const PONYTAIL_ULTRA = `${PONYTAIL_FULL}

Also question the request: before building, push back on any part the need does not justify.`;

const CAVEMAN_BASE = `IMPORTANT: You are in CAVEMAN MODE. Respond terse like smart caveman. All technical substance stay. Only fluff die.

Rules:
- Drop articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries, hedging
- Fragments OK. Short synonyms preferred. Technical terms exact
- Code blocks unchanged. Errors quoted exact
- Pattern: [thing] [action] [reason]. [next step].

Bad: "Sure! I'd be happy to help you with that. The issue you're experiencing is likely caused by..."
Good: "Bug in auth middleware. Token expiry check use \`<\` not \`<=\`. Fix:"`;

const CAVEMAN_SAFETY = `Auto-clarity: drop caveman for security warnings, irreversible action confirmations, or when user is confused. Resume after.
Boundaries: write normal code. Only compress explanations. "stop caveman" or "normal mode" reverts.`;

const CAVEMAN_LITE = `OUTPUT STYLE: CAVEMAN — level: lite
No filler, no hedging, no pleasantries. Keep articles and full sentences.
Write like a tight senior engineer in chat: complete sentences, plain prose,
no fragments unless natural. Technical terms exact. Short is good, choppy is not.
Prefer 2-4 sentence answers over bullet fragments when prose reads better.
Example: "Your component re-renders because you create a new object reference each render. Wrap it in \`useMemo\`."

${CAVEMAN_SAFETY}`;

const CAVEMAN_FULL = `OUTPUT STYLE: CAVEMAN — level: full
${CAVEMAN_BASE}

Drop articles, fragments OK, short synonyms.
Example: "New object ref each render. Inline object prop = new ref = re-render. Wrap in \`useMemo\`."

${CAVEMAN_SAFETY}`;

const CAVEMAN_ULTRA = `OUTPUT STYLE: CAVEMAN — level: ultra
${CAVEMAN_BASE}

Abbreviate (DB/auth/config/req/res/fn/impl), strip conjunctions, arrows for causality (X → Y).
Example: "Inline obj prop → new ref → re-render. \`useMemo\`."

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
        // Loopback-only guard instead of connection.admit(): the desktop app window
        // speaks a non-http scheme, and admit() throws on such requests (the empty-400
        // the panel saw). The webserver binds loopback, so a local peer is the trust
        // boundary here; unauthenticated reads/writes never leave this machine.
        const addr = req.socket?.remoteAddress ?? '';
        if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') {
          res.writeHead(403); res.end('local only'); return;
        }
        try {
          const url = new URL(req.url, 'http://local');
          if (req.method === 'GET' && url.pathname === `${ROUTE_PREFIX}/config`) {
            return json(res, 200, {
              ponytail: config.ponytail,
              caveman: config.caveman,
              ponytailText: config.ponytailText ?? '',
              cavemanText: config.cavemanText ?? '',
            });
          }
          if (req.method === 'POST' && url.pathname === `${ROUTE_PREFIX}/config`) {
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
