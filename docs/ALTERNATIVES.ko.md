# 관련 프로젝트

> [English](ALTERNATIVES.md)

2026-07-21 기준으로 확인했습니다.

| 프로젝트 | 중심 기능 | ThreadDeck과의 차이 |
| --- | --- | --- |
| [Codex Micro Stream Deck Emulator](https://github.com/mpociot/codex-micro-stream-deck-emulator) | 실제 Stream Deck을 ChatGPT에 가상 Codex Micro로 표시 | Micro HID/RPC 프로토콜을 재구현하고 실행 shim 또는 제한된 권한의 가상 HID를 사용합니다. ThreadDeck은 공식 Stream Deck 플러그인 런타임 안에서 Codex Desktop 작업 상태를 직접 읽습니다. |
| [Codex Deck](https://github.com/dazer1234/codex-stream-deck) | Codex 내부 이벤트 브리지를 통한 Codex Micro 제어 | Micro 중심의 더 넓은 동작 제어입니다. ThreadDeck은 실제 Neo에서 검증한 Codex Desktop 작업 대시보드입니다. |
| [Token Deck](https://github.com/leask/token-deck) | AI 한도와 Mac 하드웨어 지표 | 사용량·지표 중심이며 Codex 작업 목록과 작업 전환은 없습니다. |
| [AI Usage Limits](https://github.com/lenadweb/stream-deck-ai-limits) | 여러 AI 제공자의 한도 확인 | 제공자 공통 사용량 표시에 집중하며 Codex 작업 상태는 없습니다. |
| [UsageButtons](https://github.com/anthonybaldwin/UsageButtons) | 여러 AI 제공자의 사용량 버튼 | 작업 대시보드보다 사용량 확인에 집중합니다. |
| [AI Usage Stream Deck](https://github.com/hudsonbrendon/ai-usage-streamdeck) | Claude·Codex 사용량 | 작업 대시보드보다 사용량 확인에 집중합니다. |
| [AgentDeck](https://puritysb.github.io/AgentDeck/) | 여러 하드웨어 화면을 이용한 멀티 에이전트 조율 | 훨씬 넓은 조율 범위를 다루며 Neo 전용 Codex Desktop 보조 도구가 아닙니다. |
| [What's Left?](https://marketplace.elgato.com/product/whats-left-9f7f6fd3-19cb-4761-a80c-387cbb550a1d) | macOS용 유료 AI 한도 표시 | 유료 한도 모니터이며 Codex 작업 대시보드는 없습니다. |

ThreadDeck은 더 풍부한 Codex Micro 제어 화면을 대체하려 하지 않습니다. 고정·최근 작업 제목, 진행·완료 상태, 시간, 추론·속도 단서, 완료 펄스, 한 번 누른 작업 이동을 제공하는 한눈에 보는 물리 작업 모니터가 목표입니다.
