# 관련 프로젝트

> [English](ALTERNATIVES.md)

2026-07-21 기준으로 확인했습니다.

| 프로젝트 | 중심 기능 | ThreadDeck과의 차이 |
| --- | --- | --- |
| [Codex Micro Stream Deck Emulator](https://github.com/mpociot/codex-micro-stream-deck-emulator) | 실제 Stream Deck을 ChatGPT에 가상 Codex Micro로 표시 | Micro HID/RPC 프로토콜을 재구현하고 실행 shim 또는 제한된 권한의 가상 HID를 사용합니다. ThreadDeck은 공식 Stream Deck 플러그인 런타임 안에서 Codex Desktop 작업 상태를 직접 읽습니다. |
| [Codex Deck](https://github.com/dazer1234/codex-stream-deck) | Codex 내부 이벤트 브리지를 통한 Codex Micro 제어 | 이 프로젝트의 렌더러 연결 연구가 ThreadDeck Micro 어댑터에 직접 참고됐습니다. ThreadDeck은 별도 8개 작업 대시보드, Neo 프로필, 대기열·목표·완료 알림, 보호된 기존 방식 폴백, 한영 배포를 더합니다. |
| [Token Deck](https://github.com/leask/token-deck) | AI 한도와 Mac 하드웨어 지표 | 사용량·지표 중심이며 Codex 작업 목록과 작업 전환은 없습니다. |
| [AI Usage Limits](https://github.com/lenadweb/stream-deck-ai-limits) | 여러 AI 제공자의 한도 확인 | 제공자 공통 사용량 표시에 집중하며 Codex 작업 상태는 없습니다. |
| [UsageButtons](https://github.com/anthonybaldwin/UsageButtons) | 여러 AI 제공자의 사용량 버튼 | 작업 대시보드보다 사용량 확인에 집중합니다. |
| [AI Usage Stream Deck](https://github.com/hudsonbrendon/ai-usage-streamdeck) | Claude·Codex 사용량 | 작업 대시보드보다 사용량 확인에 집중합니다. |
| [AgentDeck](https://puritysb.github.io/AgentDeck/) | 여러 하드웨어 화면을 이용한 멀티 에이전트 조율 | 훨씬 넓은 조율 범위를 다루며 Neo 전용 Codex Desktop 보조 도구가 아닙니다. |
| [What's Left?](https://marketplace.elgato.com/product/whats-left-9f7f6fd3-19cb-4761-a80c-387cbb550a1d) | macOS용 유료 AI 한도 표시 | 유료 한도 모니터이며 Codex 작업 대시보드는 없습니다. |

ThreadDeck은 이제 순수 손쉬운 사용 제어기가 아니라 결합형입니다. 지원되는 기본 제어와 슬롯 6개는 Codex Micro 이벤트를 사용하고, 독립된 8개 카드 모니터가 고정·최근 제목, 원격 작업, 대기열, 목표, 시간, 완료 펄스, 폴백 전환을 담당합니다. 두 프로젝트는 여전히 상호 보완적이며 원본 MIT 출처는 [오픈소스 구성표](OPEN_SOURCE.ko.md)에 보존합니다.
