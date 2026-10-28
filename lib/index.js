/**
 * caveman-plugin-dsh — Caveman voice for DSH, TUI and web.
 *
 * Ships three packaged skills (caveman / ultracave / megacave), an always-on
 * system-prompt section restricted to the ROOT agent (subagent reports stay
 * verbose), a `/caveman on|off|status` command, and a TUI status badge.
 *
 * Everything here is a plain plugin surface: no dsh core change, no mediated
 * capability, no storage. Service access uses `ctx.inject([...])` — a row
 * context carries no service store of its own. The section text is a provider
 * that emits the rule only when the assembly scope is the root agent
 * (`agents.roots()`); the scope key of an assembly is the agent itself.
 *
 * The skill files and the always-on rule text come from
 * JuliusBrussee/caveman (Apache-2.0); everything else is MIT.
 *
 * @module caveman-plugin-dsh
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** Bundled skills. Frontmatter drives routing: the folded `description:` is
 * the model-visible trigger, `disable-model-invocation: true` keeps a skill
 * out of the model catalog. */
const SKILLS = [
  { name: 'caveman', file: '../skills/caveman/SKILL.md' },
  { name: 'ultracave', file: '../skills/ultracave/SKILL.md' },
  { name: 'megacave', file: '../skills/megacave/SKILL.md' },
]

/** Section placement: between first-party plan (500) and team policy (600). */
const ALWAYS_ON_ORDER = 550
const ALWAYS_ON_SECTION = 'caveman:voice'
const BADGE_KEY = 'caveman:mode'

/** Voice levels. `caveman` is the base rule; deeper levels append a one-line
 * modifier so the section remains a single registered provider. */
const LEVELS = new Set(['caveman', 'ultracave', 'megacave'])
const LEVEL_SUFFIX = {
  caveman: '',
  ultracave: '\n\nUltra: fragments only, no connective words.',
  megacave: '\n\nMega: answer in Classical Chinese (文言文).',
}

/** Deterministic fallbacks, used when the decision model is absent or fails. */
const ON_PHRASES = new Set(['caveman on', 'caveman mode', 'talk like caveman', 'be brief', 'less tokens'])
const OFF_PHRASES = new Set(['stop caveman', 'normal mode', 'caveman off'])

/** Cheap gate: only these short candidates reach the decision model. */
const CANDIDATE = /caveman|normal mode|modo normal|seja breve|be brief|less tokens|文言文/i
const MAX_CANDIDATE_CHARS = 120

const DECISION_DEFAULTS = {
  model: 'typesafe/jev-router',
  baseUrl: 'https://openrouter.ai/api/v1',
  timeoutMs: 1500,
}

/** User-owned state file. 0700 dir, 0600 file, atomic writes. */
const CONFIG_DIR = join(homedir(), '.config', 'caveman-plugin-dsh')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const MODEL_ID = /^[\w.-]+\/[\w.:-]+$/

/**
 * Read the state file, generating it (and the directory) on first use.
 * A corrupt file is moved aside and replaced; every field is validated.
 */
function loadConfig(defaults) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
    chmodSync(CONFIG_DIR, 0o700)
  } catch { /* keep going: the write below will report */ }

  let raw
  try {
    raw = readFileSync(CONFIG_FILE, 'utf8')
  } catch {
    raw = undefined
  }

  let parsed
  let corrupt = false
  if (raw !== undefined) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      corrupt = true
      try { renameSync(CONFIG_FILE, `${CONFIG_FILE}.bak-${Date.now()}`) } catch { /* ignore */ }
      console.warn('[caveman-plugin-dsh] config.json was not JSON; regenerated (old file kept as .bak)')
    }
  }

  const state = {
    mode: parsed?.mode === 'off' || parsed?.mode === 'on' ? parsed.mode : defaults.mode,
    level: LEVELS.has(parsed?.level) ? parsed.level : 'caveman',
    decision: parsed?.decision !== false,
    model: MODEL_ID.test(String(parsed?.model ?? '')) ? parsed.model : defaults.model,
    baseUrl: String(parsed?.baseUrl ?? defaults.baseUrl).replace(/\/+$/, '') || defaults.baseUrl,
    apiKey: typeof parsed?.apiKey === 'string' ? parsed.apiKey : '',
  }

  if (raw === undefined || corrupt) {
    try { saveConfig(state) } catch (err) {
      console.warn('[caveman-plugin-dsh] could not create config:', err?.message ?? err)
    }
  } else {
    try {
      if ((statSync(CONFIG_FILE).mode & 0o077) !== 0) {
        console.warn(`[caveman-plugin-dsh] ${CONFIG_FILE} is group/other readable; 0600 recommended`)
      }
    } catch { /* ignore */ }
  }
  return state
}

/** Atomic write: temp file in the same dir, 0600, then rename. */
function saveConfig(state) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 1, ...state }, null, 2) + '\n', { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, CONFIG_FILE)
}

/** Show only the head and tail of a secret. */
function maskKey(key) {
  if (!key) return 'not set'
  return key.length <= 12 ? '***' : `${key.slice(0, 7)}…${key.slice(-4)}`
}

function read(rel) {
  return readFileSync(new URL(rel, import.meta.url), 'utf8').trim()
}

/** Split a SKILL.md into its YAML frontmatter fields (flat, block-scalar
 * aware) and body. Returns `{}` when there is no frontmatter. */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { fields: {}, body: content }
  const fields = {}
  let key = null
  for (const line of match[1].split(/\r?\n/)) {
    const entry = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/)
    if (entry) {
      key = entry[1]
      const value = entry[2].trim()
      fields[key] = value === '>' || value === '|' || value === '>-' || value === '|-' ? '' : value
      continue
    }
    if (key && /^\s+/.test(line)) {
      const piece = line.trim()
      if (!piece) continue
      fields[key] = fields[key] ? `${fields[key]} ${piece}` : piece
    } else if (key && line.trim() === '') {
      // blank line inside a block scalar
    } else {
      key = null
    }
  }
  return { fields, body: match[2] }
}

/** Strip matching YAML quotes from a scalar. */
function unquote(value) {
  const m = String(value ?? '').match(/^(['"])([\s\S]*)\1$/)
  return m ? m[2] : String(value ?? '')
}

function skillMeta(content, fallbackName) {
  const { fields } = parseFrontmatter(content)
  const description = unquote(fields.description).trim()
  return {
    description: description || `Caveman voice skill (${fallbackName}). Be brief, keep every fact.`,
    modelInvocable: unquote(fields['disable-model-invocation']).toLowerCase() !== 'true',
  }
}

/** Flatten the text blocks of a user message. */
function textOf(message) {
  if (typeof message?.content === 'string') return message.content.trim()
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ')
    .trim()
}

/** Coerce a config value; JSON/settings may hand us strings. */
function flag(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return !['false', '0', 'no', 'off'].includes(value.trim().toLowerCase())
  return Boolean(value)
}

export const name = 'caveman-plugin-dsh'

/**
 * Wire the plugin.
 * @param ctx - Cordis context of the row.
 * @param config - plugin config; every key is optional.
 */
export function apply(ctx, config = {}) {
  // Row config only seeds the state file; the file is the runtime truth.
  const cfg = {
    alwaysOn: flag(config.alwaysOn, true),
    commands: flag(config.commands, true),
    status: flag(config.status, true),
    decision: {
      model: config.decision?.model || DECISION_DEFAULTS.model,
      baseUrl: String(config.decision?.baseUrl || DECISION_DEFAULTS.baseUrl).replace(/\/+$/, ''),
      apiKey: config.decision?.apiKey || '',
      timeoutMs: Number(config.decision?.timeoutMs) > 0 ? Number(config.decision.timeoutMs) : DECISION_DEFAULTS.timeoutMs,
    },
  }

  const state = loadConfig({
    mode: cfg.alwaysOn ? 'on' : 'off',
    model: cfg.decision.model,
    baseUrl: cfg.decision.baseUrl || DECISION_DEFAULTS.baseUrl,
  })

  const disposers = []
  const connect = (deps, fn) => {
    try {
      disposers.push(ctx.inject(deps, fn))
    } catch (err) {
      console.warn(`[caveman-plugin-dsh] inject ${deps.join(',')} failed:`, err?.message ?? err)
    }
  }

  const ruleText = (() => {
    try {
      return read('../rules/caveman-activate.md')
    } catch {
      return ''
    }
  })()

  /** Root agent the voice follows (children are excluded) and the section disposer. */
  let main
  let sectionDispose = null
  let enabled = state.mode === 'on'
  let level = state.level
  let decision = state.decision
  let model = state.model
  let baseUrl = state.baseUrl
  let storedKey = state.apiKey

  /** Status service plus the activation identity that owns our key. */
  const tuiStatus = { set: undefined, identity: undefined }

  function renderBadge() {
    if (!cfg.status || !tuiStatus.set) return
    try {
      tuiStatus.set(BADGE_KEY, enabled ? 'caveman on' : undefined)
    } catch {
      /* status is cosmetic */
    }
  }

  // The section is registered once, globally, and its text is a provider: the
  // scope of an assembly IS the agent, and subagent contexts inherit the parent
  // scope, so the provider returns '' unless the assembly belongs to the main
  // agent. That keeps subagent reports in full prose while costing nothing.
  function sectionText(context) {
    if (process.env.CAVE_DEBUG) {
      try {
        appendFileSync(join(tmpdir(), 'caveman-plugin-dsh.log'), JSON.stringify({ scope: context?.scope?.id ?? null, main: main?.id ?? null, level, enabled }) + '\n')
      } catch { /* debug only */ }
    }
    if (!enabled || ruleText === '') return ''
    return context?.scope === main ? ruleText + (LEVEL_SUFFIX[level] ?? '') : ''
  }

  function registerSection(systemPrompt) {
    if (sectionDispose) return
    try {
      sectionDispose = systemPrompt.section({
        name: ALWAYS_ON_SECTION,
        order: ALWAYS_ON_ORDER,
        text: sectionText,
        interpolate: false,
      })
    } catch (err) {
      console.warn('[caveman-plugin-dsh] section failed:', err?.message ?? err)
    }
  }

  function setEnabled(on) {
    enabled = on
    persist()
    renderBadge() // the provider reads `enabled` at the next assembly
  }

  function setLevel(next) {
    level = next
    persist()
    renderBadge()
  }

  /** Persist the whole state; best effort, never breaks the caller. */
  function persist() {
    try {
      saveConfig({ mode: enabled ? 'on' : 'off', level, decision, model, baseUrl, apiKey: storedKey })
    } catch (err) {
      console.warn('[caveman-plugin-dsh] could not save config:', err?.message ?? err)
    }
  }

  // ---- decision model ----------------------------------------------------
  // An inline apiKey from the row wins over the file (CI/injection); the file
  // is the normal place for it.
  const apiKey = () => cfg.decision.apiKey || storedKey
  const decisionReady = () => decision && apiKey() !== ''

  /** Ask OpenRouter (jev-router by default) for the intent of one message.
   * Returns `{ intent, level }` or `undefined`; never throws, never outlives
   * the turn's signal. */
  async function classify(text, signal) {
    const prompt = [
      'You classify one chat message about a terse "caveman" writing mode.',
      'Reply with compact JSON only:',
      '{"intent":"on"|"off"|"other","level":"caveman"|"ultracave"|"megacave"|null}',
      'on = start terse mode or ask for it, off = stop it or return to normal,',
      'other = the phrase just happens to match. level is the requested intensity,',
      'null when unspecified.',
    ].join(' ')
    const body = JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 24,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: `state: ${enabled ? 'on' : 'off'}\nmessage: <<<${text}>>>` },
      ],
    })
    const timeout = AbortSignal.timeout(cfg.decision.timeoutMs)
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey()}`,
          'x-title': 'caveman-plugin-dsh',
        },
        body,
        signal: composed,
      })
      if (!res.ok) return undefined
      const data = await res.json()
      const raw = String(data?.choices?.[0]?.message?.content ?? '').trim()
      const json = raw.replace(/^```(?:json)?\s*|\s*```$/g, '')
      const parsed = JSON.parse(json)
      const intent = parsed?.intent
      if (intent !== 'on' && intent !== 'off' && intent !== 'other') return undefined
      if (process.env.CAVE_DEBUG) appendFileSync(join(tmpdir(), 'caveman-plugin-dsh.log'), JSON.stringify({ event: 'classify', intent, level: parsed?.level ?? null }) + '\n')
      return { intent, level: LEVELS.has(parsed?.level) ? parsed.level : undefined }
    } catch (err) {
      if (process.env.CAVE_DEBUG) appendFileSync(join(tmpdir(), 'caveman-plugin-dsh.log'), JSON.stringify({ event: 'classify-fail', msg: String(err?.message ?? err) }) + '\n')
      return undefined // timeout, offline, bad JSON: caller falls back
    }
  }

  /** Resolve the intent of a user message: exact phrases win, the model
   * disambiguates the rest, and an exact-only heuristic is the last resort. */
  async function resolveIntent(text, signal) {
    const normalized = text.trim().toLowerCase().replace(/[.!?]+$/, '')
    if (normalized === '/caveman' || normalized.startsWith('/caveman ')) {
      const arg = normalized.slice('/caveman'.length).trim()
      if (arg === 'off') return { intent: 'off' }
      if (arg === 'on') return { intent: 'on' }
      if (LEVELS.has(arg)) return { intent: 'on', level: arg }
      return undefined // /caveman or /caveman status: the command reports it
    }
    if (OFF_PHRASES.has(normalized)) return { intent: 'off' }
    if (ON_PHRASES.has(normalized)) return { intent: 'on' }

    if (process.env.CAVE_DEBUG) {
      try {
        appendFileSync(join(tmpdir(), 'caveman-plugin-dsh.log'), JSON.stringify({ event: 'gate', normalized, ready: decisionReady(), candidate: CANDIDATE.test(normalized), len: normalized.length }) + '\n')
      } catch (e) { appendFileSync(join(tmpdir(), 'caveman-plugin-dsh.log'), 'gate-threw ' + e.message + '\n') }
    }
    if (!decisionReady() || normalized.length > MAX_CANDIDATE_CHARS || !CANDIDATE.test(normalized)) return undefined
    const decided = await classify(normalized, signal)
    if (decided === undefined) return undefined
    return decided
  }

  function applyIntent(decision) {
    if (process.env.CAVE_DEBUG) appendFileSync(join(tmpdir(), 'caveman-plugin-dsh.log'), JSON.stringify({ event: 'apply', decision, enabled }) + '\n')
    if (decision.level !== undefined) level = decision.level
    if (decision.intent === 'on' && !enabled) setEnabled(true)
    else if (decision.intent === 'off' && enabled) setEnabled(false)
    else if (decision.level !== undefined && enabled) renderBadge()
  }

  /** Known model ids from the endpoint (public list, no key needed). */
  async function listModels() {
    const ctrl = AbortSignal.timeout(2000)
    const res = await fetch(`${baseUrl}/models`, { signal: ctrl })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const ids = (data?.data ?? []).map((m) => String(m?.id ?? '')).filter((id) => MODEL_ID.test(id))
    // decision-ish first: routers, jev, small/fast families
    const rank = (id) => (/jev|router/i.test(id) ? 0 : /flash|mini|nano|haiku|lite/i.test(id) ? 1 : 2)
    return ids.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  }

  /** Accept only ids the endpoint knows; tolerate an offline endpoint when the
   * shape is plausible. Returns `{ ok, reason }`. */
  async function validateModel(id) {
    if (!MODEL_ID.test(id)) return { ok: false, reason: 'expected vendor/model' }
    try {
      const ids = await listModels()
      return ids.includes(id) ? { ok: true } : { ok: false, reason: 'not offered by this endpoint' }
    } catch (err) {
      return { ok: true, reason: `endpoint unreachable (${err?.message ?? err}); kept as typed` }
    }
  }

  function attachAgent(agent) {
    if (agent === undefined || main === agent) return
    main = agent // newest root agent wins; children never replace it
    renderBadge()
  }

  // ---- 1) Skills (model + user invocable, except the deep ones) ----------
  connect(['skills'], (scope) => {
    for (const s of SKILLS) {
      try {
        const content = read(s.file)
        const meta = skillMeta(content, s.name)
        disposers.push(scope.skills.register({
          name: s.name,
          description: meta.description,
          content,
          invocation: { modelInvocable: meta.modelInvocable, userInvocable: true },
          provider: 'caveman-plugin-dsh',
          source: 'bundled',
        }))
      } catch (err) {
        console.warn(`[caveman-plugin-dsh] skill ${s.name} not registered:`, err?.message ?? err)
      }
    }
  })

  // ---- 2) Status badge ---------------------------------------------------
  connect(['tuiStatus'], (scope) => {
    tuiStatus.set = scope.tuiStatus.set.bind(scope.tuiStatus)
    tuiStatus.identity = scope
    renderBadge()
  })

  // ---- 3) System prompt section ------------------------------------------
  connect(['systemPrompt'], (scope) => registerSection(scope.systemPrompt))

  // ---- 4) Main-agent tracking (identity for the provider filter) ---------
  connect(['agents'], (scope) => {
    const tryAdopt = () => {
      let roots = []
      try { roots = scope.agents.roots() } catch { /* registry not ready */ }
      for (const agent of roots) attachAgent(agent)
    }
    tryAdopt()

    // Only a ROOT agent drives the voice; delegated children must report in
    // full prose. `roots()` is authoritative — an agent has no parent field.
    const onCreated = (payload) => {
      try {
        if (scope.agents.roots().includes(payload?.agent)) attachAgent(payload.agent)
      } catch { /* registry gone */ }
    }
    const onDisposed = (payload) => {
      if (payload?.agent === main) main = undefined
    }
    try {
      disposers.push(ctx.on('agent/created', onCreated, { global: true }))
      disposers.push(ctx.on('agent/disposed', onDisposed, { global: true }))
    } catch (err) {
      console.warn('[caveman-plugin-dsh] agent events unavailable:', err?.message ?? err)
    }
    renderBadge()
  })

  // ---- 5) `/caveman on|off|status` command -------------------------------
  connect(['commands'], (scope) => {
    if (!cfg.commands) return
    try {
      disposers.push(scope.commands.register({
        name: 'caveman',
        description: 'Terse caveman voice: /caveman on | off | status | levels | jev | key | model | endpoint',
        input: { hint: 'on | off | status | levels | jev | key | model | endpoint' },
        recordInput: true,
        handler: async ({ rawInput }) => {
          const input = String(rawInput ?? '').trim()
          const [verb, ...rest] = input.split(/\s+/)
          const arg = rest.join(' ').trim()
          const action = (verb ?? '').toLowerCase()

          // voice
          if (action === '' || action === 'status') {
            const jev = !decision ? 'off' : apiKey() === '' ? 'no-key' : 'on'
            return { kind: 'success', text: `caveman ${enabled ? `on (${level})` : 'off'} · jev: ${jev}` }
          }
          if (action === 'off') {
            setEnabled(false)
            return { kind: 'success', text: 'caveman off — normal prose.' }
          }
          if (action === 'on' || LEVELS.has(action)) {
            if (LEVELS.has(action)) setLevel(action)
            setEnabled(true)
            return { kind: 'success', text: `caveman on — level ${level}.` }
          }

          // decision layer
          if (action === 'jev') {
            const sub = arg.toLowerCase()
            if (sub === 'on') {
              if (apiKey() === '') return { kind: 'error', text: 'no API key — set one with /caveman key <sk-or-…>.' }
              if (!decision) { decision = true; persist() }
              return { kind: 'success', text: `jev on — model ${model}.` }
            }
            if (sub === 'off') {
              if (decision) { decision = false; persist() }
              return { kind: 'success', text: 'jev off — exact phrases only.' }
            }
            const jev = !decision ? 'off' : apiKey() === '' ? 'no-key' : 'on'
            return { kind: 'success', text: `jev: ${jev} · model ${model} · key ${maskKey(apiKey())}` }
          }

          // credential
          if (action === 'key') {
            if (arg === '') return { kind: 'success', text: `key ${maskKey(apiKey())} · file ${CONFIG_FILE}` }
            if (arg.toLowerCase() === 'clear') {
              storedKey = ''
              persist()
              return { kind: 'success', text: 'key cleared — jev is inert until a new key.' }
            }
            storedKey = arg
            decision = true
            persist()
            return { kind: 'success', text: `key saved (${maskKey(arg)}) and jev on.` }
          }

          // endpoint (any OpenAI-compatible base URL)
          if (action === 'endpoint') {
            if (arg === '') return { kind: 'success', text: `endpoint ${baseUrl}` }
            if (arg.toLowerCase() === 'reset') {
              baseUrl = DECISION_DEFAULTS.baseUrl
              persist()
              return { kind: 'success', text: `endpoint reset to ${baseUrl}.` }
            }
            if (!/^https?:\/\/[^\s]+$/i.test(arg)) return { kind: 'error', text: 'endpoint must be an http(s) URL.' }
            baseUrl = arg.replace(/\/+$/, '')
            persist()
            return { kind: 'success', text: `endpoint ${baseUrl}.` }
          }

          // model choice
          if (action === 'model') {
            if (arg === '') return { kind: 'success', text: `model ${model} · endpoint ${baseUrl}` }
            if (arg.toLowerCase() === 'list') {
              try {
                const ids = await listModels()
                const shown = ids.slice(0, 20)
                return { kind: 'success', text: `${ids.length} models. First ${shown.length}:\n${shown.join('\n')}\n\n/caveman model <id> to choose.` }
              } catch (err) {
                return { kind: 'error', text: `could not list models: ${err?.message ?? err}` }
              }
            }
            const verdict = await validateModel(arg)
            if (!verdict.ok) return { kind: 'error', text: `model "${arg}" rejected: ${verdict.reason}.` }
            model = arg
            persist()
            return { kind: 'success', text: `model ${model}${verdict.reason ? ` (${verdict.reason})` : ''}.` }
          }

          return {
            kind: 'error',
            text: `unknown option "${action}" — use on, off, status, caveman, ultracave, megacave, jev, key, model or endpoint.`,
          }
        },
      }))
    } catch (err) {
      console.warn('[caveman-plugin-dsh] command not registered:', err?.message ?? err)
    }
  })

  // ---- 6) Spoken toggle: `stop caveman` / `normal mode` / "be brief" ------
  // A waterfall listener on the step boundary. Deterministic phrases win, the
  // decision model only disambiguates loose ones, and the turn itself is never
  // blocked for longer than `decision.timeoutMs`.
  try {
    disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
      try {
        if (process.env.CAVE_DEBUG) {
          appendFileSync(join(tmpdir(), 'caveman-plugin-dsh.log'), JSON.stringify({ event: 'pre-step', agent: payload?.agent?.id ?? null, main: main?.id ?? null, same: payload?.agent === main }) + '\n')
        }
        if (payload?.agent !== main) return await next()
        const last = (payload.messages ?? []).at(-1)
        const text = textOf(last)
        if (text === '') return await next()
        const decision = await resolveIntent(text, payload.signal)
        if (decision !== undefined) applyIntent(decision)
      } catch {
        /* never break the step */
      }
      return await next()
    }, { global: true }))
  } catch (err) {
    console.warn('[caveman-plugin-dsh] pre-step hook unavailable:', err?.message ?? err)
  }

  // ---- cleanup -----------------------------------------------------------
  ctx.effect(() => () => {
    try { tuiStatus.set?.(BADGE_KEY, undefined, tuiStatus.identity) } catch { /* badge is cosmetic */ }
    try { sectionDispose?.() } catch { /* already released */ }
    for (const dispose of disposers) {
      try { dispose?.() } catch { /* already released */ }
    }
  })
}
