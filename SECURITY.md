# Security and privacy

ThreadDeck runs locally. It does not contain telemetry, analytics, an update server, or code that uploads Codex task metadata.

To draw task cards, the plugin reads local Codex state under `~/.codex`. To draw the quota ring, it launches the separately installed `codexbar` command. Keyboard and media actions are emitted by a small native helper and require macOS Accessibility permission for Stream Deck.

The push-to-talk action temporarily suspends local processes that Core Audio reports as actively producing sound, then resumes only those same process IDs when the key is released. A crash handler releases the held keyboard modifiers and resumes tracked media processes where possible.

## Reporting an issue

Please open a GitHub security advisory after the repository is published. Until then, report privately to the repository owner. Do not attach `~/.codex` databases, session files, tokens, cookies, or screenshots containing private task titles to a public issue.
