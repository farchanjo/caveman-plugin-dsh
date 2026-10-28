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
import { appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  const cfg = {
    alwaysOn: flag(config.alwaysOn, true),
    commands: flag(config.commands, true),
    status: flag(config.status, true),
  }

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
  let enabled = cfg.alwaysOn

  const tuiStatus = { set: undefined }

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
        appendFileSync(join(tmpdir(), 'caveman-plugin-dsh.log'), JSON.stringify({ scope: context?.scope?.id ?? null, agent: context?.agent?.id ?? null, main: main?.id ?? null }) + '\n')
      } catch { /* debug only */ }
    }
    if (!enabled || ruleText === '') return ''
    return context?.scope === main ? ruleText : ''
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
    renderBadge() // the provider reads `enabled` at the next assembly
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
        description: 'Terse caveman voice: /caveman on | off | status',
        input: { hint: 'on | off | status' },
        recordInput: true,
        handler: ({ rawInput }) => {
          const action = String(rawInput ?? '').trim().toLowerCase()
          if (action === 'on') {
            setEnabled(true)
            return { kind: 'success', text: 'caveman on — answers terse, facts kept.' }
          }
          if (action === 'off') {
            setEnabled(false)
            return { kind: 'success', text: 'caveman off — normal prose.' }
          }
          if (action === 'status' || action === '') {
            return { kind: 'success', text: `caveman ${enabled ? 'on' : 'off'}.` }
          }
          return { kind: 'error', text: `unknown option "${action}" — use on, off or status.` }
        },
      }))
    } catch (err) {
      console.warn('[caveman-plugin-dsh] command not registered:', err?.message ?? err)
    }
  })

  // ---- cleanup -----------------------------------------------------------
  ctx.effect(() => () => {
    try { tuiStatus.set?.(BADGE_KEY, undefined) } catch { /* badge is cosmetic */ }
    try { sectionDispose?.() } catch { /* already released */ }
    for (const dispose of disposers) {
      try { dispose?.() } catch { /* already released */ }
    }
  })
}
