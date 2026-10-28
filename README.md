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
| `/caveman jev on\|off\|status` | decision layer |
| `/caveman key <sk-or-…>` · `key` · `key clear` | store/show(masked)/drop the API key |
| `/caveman model [list\|<id>]` | list or choose the decision model |
| `/caveman endpoint [<url>\|reset]` | point at any OpenAI-compatible endpoint |

Spoken phrases work too and do not need a slash: "stop caveman", "normal mode",
"talk like caveman", "be brief". A loose phrase ("pode voltar ao modo normal?")
is disambiguated by the decision model before it is acted on.

The skills also self-trigger on phrasing: "talk like caveman", "be brief",
"less tokens", "caveman mode". `stop caveman` and `normal mode` end it in
conversation.

State lives in the process: `/caveman off` lasts until restart, and the
`alwaysOn` config is the boot default.

## Decision model (optional)

Loose phrasing is classified before the plugin toggles anything. Deterministic
phrases never call it; only short messages that mention caveman/brief/normal-mode
do. The model is chosen by you — `typesafe/jev-router` out of the box, any
OpenRouter model via `/caveman model`, any OpenAI-compatible endpoint via
`/caveman endpoint`.

It fails open: no key, offline, timeout (1.5 s) or junk JSON means the exact
heuristics still apply and the turn never waits longer than the timeout.

### State file

`~/.config/caveman-plugin-dsh/config.json` — created on first run, directory
`0700`, file `0600`, atomic writes. It holds the key, the model, the endpoint,
`jev` on/off, and the voice mode/level, so everything survives a restart.

```json
{
  "version": 1,
  "mode": "on",
  "level": "caveman",
  "decision": true,
  "model": "typesafe/jev-router",
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKey": "sk-or-…"
}
```

No environment variable is read. A corrupt file is moved to `config.json.bak-<ts>`
and regenerated; a file looser than `0600` logs a warning. The key is only ever
echoed masked.

Privacy: the candidate message and the current on/off state are sent to the
configured endpoint, and only when a candidate is detected.

## Configuration

Optional keys in the profile row's `config`:

| Key | Default | Meaning |
|---|---|---|
| `alwaysOn` | `true` | initial voice mode when the file is first created |
| `decision.timeoutMs` | `1500` | hard cap per classification |
| `decision.apiKey` | – | inline key, wins over the file |
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
