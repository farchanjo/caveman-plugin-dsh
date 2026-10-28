# caveman-plugin-dsh

**Caveman voice for DSH ([dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)) — terminal and web.**
Why use many token when few token do trick.

A dsh plugin that makes the agent answer terse: fragments over sentences,
fluff gone, every technical fact kept. It ships the
[caveman](https://github.com/JuliusBrussee/caveman) voice skills, an always-on
system-prompt section, a `/caveman` toggle and a TUI badge.

- **Plugin-only.** No dsh core change, no patch, no fork. Plain Cordis services.
- **Host-agnostic.** Loads in the `tui` profile *and* the `web` profile.
- **Subagent-safe.** Delegated children keep full prose; only the root agent
  gets the voice.
- **Zero dependencies.** Plain ESM, no build step, no npm install, no network.

```
/caveman on        # terse from now on
/caveman off       # normal prose
/caveman status    # current mode
```

## Install

Requires dsh 0.17+ (plugin manifest v0.15). Clone, then add it to the profile(s)
you use:

```bash
git clone https://github.com/farchanjo/caveman-plugin-dsh.git
dsh plugin --profile tui add ./caveman-plugin-dsh   # terminal UI
dsh plugin --profile web add ./caveman-plugin-dsh   # web UI
```

Restart dsh afterwards. Remove with `dsh plugin --profile <p> remove caveman-plugin-dsh`.

The manifest is validated by the host's own `validatePlugin`; it declares the
`commands.dsh/v1alpha1#Command` contract and the `commands.invoke` permission.
No grants file is needed: no mediated capability and no storage are used.

## Usage

`/caveman` (or `/caveman help`) opens a text wizard in the footer:

```
1on 2off 3st 4cav 5ultra 6mega · 7jev+ 8jev- 9key- 10ls 11url 12key+ q
```

Type the number; the footer repaints with the new state and nothing is sent to
the model. `q` closes, any other text closes the menu and goes through as a
normal message. Prompts (`key`, model pick) consume the next line
and stay open on a bad value, showing the reason inline; `c` cancels the prompt.
The menu expires after 120 s.

| Pick | Action | Pick | Action |
|---|---|---|---|
| 1 | voice on | 7 | jev on |
| 2 | voice off | 8 | jev off |
| 3 | status | 9 | clear key |
| 4 / 5 / 6 | level caveman / ultracave / megacave | 10 | list models |
| 10 / 11 | provider typesafe / openrouter | 12 | set key |

Direct verbs still work without the menu: `/caveman on`, `/caveman off`,
`/caveman status`, `/caveman caveman|ultracave|megacave`, `/caveman jev on|off|<provider>`,
`/caveman key <k>|clear`, `/caveman model [list|<id>]`.

Spoken phrases work too and never need a slash: "stop caveman", "normal mode",
"talk like caveman", "be brief". A loose phrase ("pode voltar ao modo normal?")
is disambiguated by the decision model before it is acted on.

Every change is persisted to the state file, so the mode, level and `jev` switch
survive a restart.

## Decision model (optional)

Off until you turn it on: `/caveman jev on`. When on, loose phrasing is
classified by **Jev**, a decision model that returns typed choices with a
confidence — no text generation and no auxiliary LLM.

Two providers, same wire protocol:

| Provider | Endpoint | Models |
|---|---|---|
| `typesafe` (default) | `https://api.typesafe.ai/v1/systemone` | Jev only (`jev-latest`) |
| `openrouter` | `https://openrouter.ai/api/v1/systemone` | any of the 30 decision models (`/caveman model list`) |

`main` is a third option: the session's own model, via the kernel LLM service,
no key needed. It is the only path that uses an LLM.

```
/caveman jev on            # use the current provider
/caveman jev off           # heuristics only
/caveman jev typesafe      # switch provider (persisted)
/caveman jev openrouter
/caveman jev main          # session model, no key
```

### Keys and thresholds

Keys live in the state file, never in the environment:

```
/caveman key typesafe <key>      # save (masked echo)
/caveman key openrouter <key>
/caveman key                     # show both, masked
/caveman key clear typesafe      # drop one
```

Confidence gates are per provider: `0.70` for TypeSafe, `0.35` for OpenRouter —
the scales are not comparable across providers or models, so re-tune when you
switch model. Below the gate the classifier stays silent and heuristics apply.

Every call is capped at 1.5 s (4 s for `main`) and every failure is swallowed:
offline, 401, 429, timeout or junk JSON never blocks the turn.

Privacy: the candidate message and the on/off state go to the selected
provider; nothing else. `typesafe`/`openrouter` hit TypeSafe's API (directly or
through OpenRouter); `main` reuses the session provider.

### State file

`~/.config/caveman-plugin-dsh/config.json` — created on first run, directory
`0700`, file `0600`, atomic writes. It holds keys, provider, models, gates,
`jev` on/off, and the voice mode/level, so everything survives a restart.

```json
{
  "version": 2,
  "mode": "on",
  "level": "caveman",
  "decision": false,
  "provider": "typesafe",
  "models": { "typesafe": "jev-latest", "openrouter": "~typesafe/jev-latest" },
  "keys": { "typesafe": "", "openrouter": "" },
  "minConfidence": { "typesafe": 0.7, "openrouter": 0.35 }
}
```

A corrupt file is moved to `config.json.bak-<ts>` and regenerated; a file looser
than `0600` warns. A version-1 file is migrated (its `apiKey` becomes
`keys.openrouter`, `decision` resets to `false`).

### Why a provider factory?

`lib/decision.js` keeps both providers in one table (base URL, default model,
gate) and returns a client. The caller never branches; adding a backend is one
row. `main` stays outside the factory because it has a different transport and
no real confidence.

## Configuration

Optional keys in the profile row's `config`:

| Key | Default | Meaning |
|---|---|---|
| `alwaysOn` | `true` | initial voice mode when the file is first created |
| `decision.timeoutMs` | `1500` | hard cap per classification |
| `decision.apiKey` | – | inline OpenRouter key for CI, wins over the file |
| `commands` | `true` | register the `/caveman` command |
| `status` | `true` | show the TUI badge |

```yaml
- id: caveman-plugin-dsh
  config:
    alwaysOn: false
```

`CAVE_DEBUG=1` appends scope/classify decisions to `$TMPDIR/caveman-plugin-dsh.log`.

## Compatibility

| Host | Status |
|---|---|
| dsh `tui` 0.17 | works — voice, command, badge |
| dsh `web` | works — voice, command; no badge (the web has no `tuiStatus`) |
| subagents | excluded by design; their reports stay in full prose |

Scope of the port: this is the **voice** half of caveman. The input-compression
proxy ("read less") has no dsh plugin seam today, so it is not included.

## Layout

```
lib/index.js                   # the whole plugin (~270 lines, ESM, no build)
skills/caveman/SKILL.md        # verbatim upstream skills
skills/ultracave/SKILL.md
skills/megacave/SKILL.md
rules/caveman-activate.md      # verbatim upstream activation rule
dsh-plugin.json                # manifest v0.15
cordis.patch.yml               # profile-row insert
```

## License

Plugin code: MIT (`LICENSE`). Skills and activation rule: Apache-2.0 ©
[Julius Brussee](https://github.com/JuliusBrussee/caveman) — see `NOTICE` and
`LICENSE-Apache`. The combined work is `MIT AND Apache-2.0`.
