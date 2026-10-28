/**
 * Provider factory for the Jev decision model.
 *
 * Two backends, same wire protocol (`POST {baseUrl}` with `state` + typed
 * `questions`): OpenRouter's System One surface and TypeSafe's own endpoint.
 * Only base URL, key and default model differ, so the table is the contract —
 * adding a backend is one row, and the caller never branches.
 *
 * Every failure path returns `undefined`; the caller keeps the heuristics.
 *
 * @module caveman-plugin-dsh/decision
 */

/** Decision surface per provider. `models` says which ids are allowed. */
export const PROVIDERS = {
  typesafe: {
    baseUrl: 'https://api.typesafe.ai/v1/systemone',
    defaultModel: 'jev-latest',
    minConfidence: 0.7,
    models: 'jev-only',
    label: 'TypeSafe',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1/systemone',
    defaultModel: '~typesafe/jev-latest',
    minConfidence: 0.35,
    models: 'decisions',
    label: 'OpenRouter',
  },
}

/** `vendor/model`, with the optional `~vendor/` latest alias. */
export const MODEL_ID = /^~?[\w.-]+\/[\w.:-]+$/
export const DEFAULT_PROVIDER = 'typesafe'

export const isProvider = (id) => typeof id === 'string' && Object.hasOwn(PROVIDERS, id)

/** TypeSafe serves Jev only; OpenRouter serves a decision catalogue. */
export function allowsModel(provider, model) {
  if (!isProvider(provider) || !MODEL_ID.test(String(model ?? ''))) return false
  return PROVIDERS[provider].models === 'decisions' ? true : /^~?jev[-/]|^~?typesafe\/jev|^jev/.test(model)
}

/** Live decision-model catalogue (OpenRouter only). */
export async function listDecisionModels(key, timeoutMs) {
  const res = await fetch('https://openrouter.ai/api/v1/models?output_modalities=decisions', {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return (data?.data ?? []).map((m) => String(m?.id ?? '')).filter((id) => MODEL_ID.test(id))
}

/**
 * Build a client for one provider.
 * @returns `{ provider, model, minConfidence, label, describe, ask }` or `undefined`
 *          when the provider is unknown or keyless.
 */
export function createDecisionClient({ provider, model, apiKey, timeoutMs, minConfidence, log }) {
  if (!isProvider(provider) || !apiKey) return undefined
  const spec = PROVIDERS[provider]
  const chosen = allowsModel(provider, model) ? model : spec.defaultModel
  const gate = Number(minConfidence) > 0 && Number(minConfidence) <= 1 ? Number(minConfidence) : spec.minConfidence

  return {
    provider,
    model: chosen,
    label: spec.label,
    minConfidence: gate,
    describe: () => `${provider}/${chosen} @ ${spec.baseUrl} (min ${gate})`,

    /**
     * Ask one or more typed questions.
     * @param state - free-form application state (the candidate message)
     * @param questions - `questions` payload of the decision API
     * @returns `{ [questionId]: { choice, confidence, probabilities } }` or `undefined`
     */
    async ask(state, questions, signal) {
      const timeout = AbortSignal.timeout(timeoutMs)
      const composed = signal ? AbortSignal.any([signal, timeout]) : timeout
      try {
        const res = await fetch(spec.baseUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
            'x-title': 'caveman-plugin-dsh',
          },
          body: JSON.stringify({ state, model: chosen, questions }),
          signal: composed,
        })
        if (!res.ok) {
          log?.(`decision ${provider} HTTP ${res.status}`)
          return undefined
        }
        const data = await res.json()
        const answers = data?.answers
        if (answers === undefined || typeof answers !== 'object') return undefined
        const out = {}
        for (const [id, answer] of Object.entries(answers)) {
          if (typeof answer?.choice !== 'string') return undefined
          out[id] = {
            choice: answer.choice,
            confidence: Number(answer.confidence ?? 0),
            probabilities: answer.probabilities,
          }
        }
        return out
      } catch (err) {
        log?.(`decision ${provider} failed: ${err?.message ?? err}`)
        return undefined
      }
    },
  }
}
