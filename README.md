# pi-subagent-fragments

Pi extension that adds **fragments-based systemPrompt composition** to forked
`pi-agents-tmux` agents. Drop-in replacement: same pane lifecycle, same
`/agents:*` commands — but the agent's `systemPrompt` is now assembled from
multiple frontmatter-declared fragments at spawn time.

## About this fork

This is a fork of
[vanillagreencom/vstack](https://github.com/vanillagreencom/vstack),
specifically the [`pi-extensions/pi-agents-tmux/`](https://github.com/vanillagreencom/vstack/tree/main/pi-extensions/pi-agents-tmux)
extension. The upstream source commit is
[`faeb65af`](https://github.com/vanillagreencom/vstack/commit/faeb65af9319fddf4cb7528c224e259df6f40a24)
(version `2.8.1`).

See [`UPSTREAM.md`](./UPSTREAM.md) for sync history, cherry-pick policy, and
critical-fix fast-track rules.

## What this fork adds

A `systemPromptFragments?: string[]` frontmatter field on agent definitions,
plus a `composeAgentPrompt()` helper that joins the body and fragments into
the temp file passed to `--append-system-prompt` at spawn time.

- **Static composition only in v1** — fragments are joined once at agent
  spawn and remain immutable for the session lifetime.
- **Runtime switching deferred to v2** — see
  [specs/001-multi-prompt-injection.md § Deferred](./specs/001-multi-prompt-injection.md#11-deferred-features-v2).

For the full design, API surface, lifecycle, configuration, errors,
testing, and migration path, see
[`specs/001-multi-prompt-injection.md`](./specs/001-multi-prompt-injection.md).

## Install

```bash
npm install -g @nexquark/pi-subagent-fragments
pi install npm:@nexquark/pi-subagent-fragments
```

The `npm install -g` step downloads and unpacks the package under
`npm root -g`; the `pi install` step registers it with Pi's
`~/.pi/agent/settings.json` (or `~/.pi/settings.json` for project-local).
Restart Pi to load the extension. After registration, `/agents`,
`subagent`, `delegate_subagent`, `get_subagent_result`,
`wait_for_subagent_idle`, `steer_subagent`, and `stop_subagent` are
available alongside the existing `pi-agents-tmux` tool surface.

To uninstall:

```bash
pi remove npm:@nexquark/pi-subagent-fragments
npm uninstall -g @nexquark/pi-subagent-fragments
```

For local development from this repo (no `npm publish` round-trip
required), use `pi install --path .` from the repo root.

## License

MIT — same as upstream. See [`LICENSE`](./LICENSE) for the fork attribution
notice.