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

| Command | Effect |
|---|---|
| `/caveman on` | apply the voice, badge `caveman on` |
| `/caveman off` | drop it, badge cleared |
| `/caveman status` | report the mode |
| `/caveman ultracave` | on, fragments only |
| `/caveman megacave` | on, Classical Chinese style |

Spoken phrases work too and do not need a slash: "stop caveman", "normal mode",
"talk like caveman", "be brief". A loose phrase ("pode voltar ao modo normal?")
is disambiguated by the decision model before it is acted on.

The skills also self-trigger on phrasing: "talk like caveman", "be brief",
"less tokens", "caveman mode". `stop caveman` and `normal mode` end it in
conversation.

State lives in the process: `/caveman off` lasts until restart, and the
`alwaysOn` config is the boot default.

## Decision model (optional)

Loose phrasing is classified by an OpenRouter model — `typesafe/jev-router` by
default — before the plugin toggles anything. Deterministic phrases never call
it; only short messages that mention caveman/brief/normal-mode do.

It fails open: no key, offline, timeout (1.5 s) or junk JSON means the exact
heuristics still apply and the turn never waits longer than the timeout.

```bash
export OPENROUTER_API_KEY=sk-or-...
```

| Key (`config.decision`) | Default | Meaning |
|---|---|---|
| `enabled` | `true` | use the model for loose phrasing |
| `model` | `typesafe/jev-router` | OpenRouter model id |
| `baseUrl` | `https://openrouter.ai/api/v1` | any OpenAI-compatible endpoint |
| `apiKey` / `apiKeyEnv` | – / `OPENROUTER_API_KEY` | credential, config wins |
| `timeoutMs` | `1500` | hard cap per classification |

Privacy: only the candidate message text and the current on/off state leave the
machine, and only when a candidate is detected.

## How it works

Three ordinary plugin surfaces, nothing privileged:

| Piece | Surface |
|---|---|
| `/caveman` command | `ctx.commands.register(...)` — handler returns `{ kind, text }`, never reaches the model |
| Voice section | `ctx.systemPrompt.section({ text: provider, order: 550 })` — provider returns the rule only when the assembly scope is a root agent (`agents.roots()`), so children get `""` |
| Spoken toggles | `ctx.on('agent/pre-step', …)` waterfall — sees the user message before the model, toggles, and calls `next()` |
| `caveman` / `ultracave` / `megacave` skills | `ctx.skills.register(...)`, descriptions parsed from YAML frontmatter; the two deep variants keep `disable-model-invocation: true` |

The rule text is the upstream compiled activation block (`rules/caveman-activate.md`);
the skills are byte-identical copies. Both are Apache-2.0, see `NOTICE`.

### Why not the decision-event / storage surfaces?

`tui/input` interception and `storage.local` are host-mediated and require a
verified component identity. The admission loader refuses composition-root
activations (`mediated capability requires a non-root activation context`), so
profile rows never get one. Dropping both kept the plugin on plain services and
made it work unchanged in the web profile, where `tui/input` does not exist at
all.

## Configuration

Optional keys in the profile row's `config`:

| Key | Default | Meaning |
|---|---|---|
| `alwaysOn` | `true` | apply the voice on boot |
| `decision` | see above | decision-model block |
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
