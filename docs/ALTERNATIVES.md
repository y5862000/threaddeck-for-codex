# Related projects

> [Korean comparison](ALTERNATIVES.ko.md)

Checked on 2026-07-21.

| Project | Focus | Main difference |
| --- | --- | --- |
| [Codex Micro Stream Deck Emulator](https://github.com/mpociot/codex-micro-stream-deck-emulator) | Presents a physical Stream Deck to ChatGPT as a virtual Codex Micro | Reimplements the Micro HID/RPC protocol and uses a launch shim or entitlement-gated virtual HID; ThreadDeck stays inside the official Stream Deck plugin runtime and reads Codex Desktop task state directly. |
| [Codex Deck](https://github.com/dazer1234/codex-stream-deck) | Codex Micro controls through Codex's internal event bridge | Its renderer-bridge work directly informed ThreadDeck's Micro adapter. ThreadDeck adds a separate eight-task dashboard, Neo profile, queues/goals/completion alerts, guarded legacy fallback, and bilingual distribution. |
| [Token Deck](https://github.com/leask/token-deck) | AI quota and Mac hardware metrics | Usage/metrics only; no Codex task list or task switching. |
| [AI Usage Limits](https://github.com/lenadweb/stream-deck-ai-limits) | Multi-provider AI quota monitoring | Provider-agnostic usage display; no Codex task state. |
| [UsageButtons](https://github.com/anthonybaldwin/UsageButtons) | Multi-provider usage keys | Usage-centric rather than a task dashboard. |
| [AI Usage Stream Deck](https://github.com/hudsonbrendon/ai-usage-streamdeck) | Claude and Codex usage | Usage-centric rather than a task dashboard. |
| [AgentDeck](https://puritysb.github.io/AgentDeck/) | Multi-agent orchestration across hardware surfaces | Much broader orchestration scope, not a Neo-specific Codex Desktop companion. |
| [What's Left?](https://marketplace.elgato.com/product/whats-left-9f7f6fd3-19cb-4761-a80c-387cbb550a1d) | Paid macOS AI quota display | Paid quota monitor; no Codex task dashboard. |

ThreadDeck is now a hybrid rather than a pure Accessibility controller: Codex Micro events handle supported native controls and six slots, while its own eight-card monitor handles pinned/recent titles, remote work, queues, goals, timing, completion pulses, and fallback navigation. The projects remain complementary, and upstream MIT attribution is preserved in [Open-source inventory](OPEN_SOURCE.md).
