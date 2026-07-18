<p align="center">
  <img src="assets/plugin.svg" width="112" alt="ThreadDeck 로고">
</p>

<h1 align="center">ThreadDeck for Codex</h1>

<p align="center"><strong>Codex 작업을 한눈에.</strong></p>

<p align="center">
  macOS용 Codex Desktop을 Stream Deck Neo에서 확인하고 조작하는 로컬 우선 대시보드입니다.<br>
  작업 상태를 보고, 원하는 작업으로 이동하고, 자주 쓰는 동작을 물리 버튼 하나로 실행합니다.
</p>

<p align="center">
  <a href="https://github.com/y5862000/threaddeck-for-codex/releases"><img alt="최신 릴리스" src="https://img.shields.io/github/v/release/y5862000/threaddeck-for-codex?include_prereleases&style=flat-square"></a>
  <a href="https://github.com/y5862000/threaddeck-for-codex/actions/workflows/ci.yml"><img alt="CI 상태" src="https://img.shields.io/github/actions/workflow/status/y5862000/threaddeck-for-codex/ci.yml?style=flat-square&label=build"></a>
  <a href="LICENSE"><img alt="MIT 라이선스" src="https://img.shields.io/badge/license-MIT-10A37F?style=flat-square"></a>
  <img alt="플랫폼: macOS" src="https://img.shields.io/badge/platform-macOS-111111?style=flat-square">
  <img alt="하드웨어: Stream Deck Neo" src="https://img.shields.io/badge/hardware-Stream%20Deck%20Neo-111111?style=flat-square">
</p>

<p align="center"><a href="README.md">English</a> · <a href="#빠른-설치">빠른 설치</a> · <a href="https://github.com/y5862000/threaddeck-for-codex/releases">다운로드</a></p>

아래 기능 개요 이미지는 플러그인의 실제 버튼 렌더러에서 개인정보 없는 예시 작업으로 직접 생성했습니다. 타사 제품 화면을 복제한 이미지가 아닙니다.

![다크 모드의 ThreadDeck for Codex 기능 개요](docs/media/neo-preview.png)

아래 GIF도 같은 실제 렌더러로 만들었습니다. Ultra·고속 작업의 움직임, 대기 명령이 다음 순서로 넘어가는 순간, 작업 버튼을 길게 누른 음성 입력, 받아쓰기 뒤 자동 제출, 완료 펄스까지 하나의 흐름으로 보여줍니다.

![작업 상태, 음성 입력, 대기열 진행, 완료 펄스를 보여주는 ThreadDeck 애니메이션](docs/media/threaddeck-demo.gif)

> [!IMPORTANT]
> ThreadDeck은 Codex의 공개되지 않은 로컬 메타데이터를 읽는 독립 베타 프로젝트입니다. Codex 업데이트 뒤 작업 감지가 일시적으로 깨질 수 있습니다. Codex 상태에는 절대 쓰지 않습니다.

## 왜 만들었나요?

Codex에서는 여러 작업이 동시에 오래 실행될 수 있지만, 무엇이 진행 중인지 확인하려면 계속 앱을 봐야 합니다. ThreadDeck은 자주 확인하는 작은 정보를 물리 대시보드로 옮깁니다.

- 지금 어떤 작업이 생각 중·도구 실행 중·완료·대기·오류 상태인가?
- 얼마나 진행 중이며, 완료까지 얼마나 걸렸는가?
- 로컬·원격 컴퓨터의 고정 또는 최근 작업 중 어디로 이동할 것인가?
- 주간 한도가 얼마나 남았는가?
- 새 작업, 사이드챗, 음성 입력, 보내기, 앱 전환을 바로 실행할 수 있는가?
- 보고 있는 작업 버튼을 누른 채 말하고, 버튼을 놓으면 그 작업에 후속 요청을 자동으로 보낼 수 있는가?

단순히 기존 UI를 줄인 것이 아니라 Stream Deck Neo의 8개 키와 InfoBar 환경에 맞춰 설계했습니다.

## 버튼에서 보이는 정보

| | 버튼 | 의미 |
|---|---|---|
| <img src="docs/media/quota-key.png" width="96" alt="74가 표시된 주간 한도 버튼"> | 주간 한도 | 남은 주간 사용량을 시스템 화면 모드에 맞는 중립 단색 링으로 표시합니다. 선택 기능인 CodexBar가 필요합니다. |
| <img src="docs/media/working-task-key.png" width="96" alt="진행 중인 작업 버튼"> | 진행 중인 작업 | 현재 활동, 고정 여부, 작업 제목, 경과 시간, 추론 강도, 고속/일반 모드 단서를 표시합니다. |
| <img src="docs/media/completed-task-key.png" width="96" alt="완료된 작업 버튼"> | 완료된 작업 | 큰 완료 표시와 최종 소요 시간을 보여줍니다. 완료 시 ThreadDeck 버튼 전체에 펄스가 나타납니다. |
| <img src="docs/media/side-chat-key.png" width="96" alt="사이드챗 버튼"> | 작업 흐름 버튼 | 사이드챗, 새 작업, 음성 입력, 보내기, 앱 전환, 미디어 조작을 일관된 디자인으로 제공합니다. |

macOS 라이트 모드도 같은 정보 구조를 유지합니다.

![라이트 모드의 ThreadDeck for Codex 대시보드](docs/media/neo-preview-light.png)

## 포함된 Neo 레이아웃

기본 프로필은 3페이지이며, 설치 후 Stream Deck 앱에서 자유롭게 재배치할 수 있습니다.

1. **대시보드** — 주간 한도, 작업 1개, 새 작업, 사이드챗, 누르는 동안 음성 입력, 보내기, 앱 전환, ThreadDeck 뒤로가기.
2. **작업** — 작업 1~7번과 ThreadDeck 뒤로가기. 플러그인에는 8번째 작업 액션도 포함되어 있어 원하는 레이아웃에 추가할 수 있습니다.
3. **미디어** — 이전 트랙, 되감기, 재생/일시정지, 앱 실행 4개, ThreadDeck 뒤로가기. 액션 목록에는 다음 페이지, 다음 트랙, 탐색, 음소거, 음량 조절도 포함되어 있습니다.

### 작업 상태 읽는 법

- **파랑·보라 캡슐:** 작업 진행 중. 색과 은은한 움직임으로 추론 강도와 서비스 속도를 구분합니다.
- **활동 텍스트:** 생각 중, 파일 수정, 도구 실행, 검색, 검증 등 현재 단계를 표시합니다.
- **제목 앞 핀:** Codex에서 고정한 작업입니다.
- **움직이는 시간:** 작업 중에는 1초마다 경과 시간이 갱신됩니다.
- **주황색 `+N` 배지:** 해당 작업에 감지된 대기 명령 수입니다.
- **체크와 멈춘 시간:** 작업이 완료되었고 최종 소요 시간이 고정되었습니다.
- **초록 완료 펄스:** 화면에 보이는 모든 ThreadDeck 소유 버튼이 첫 완료 프레임을 함께 표시하고, 해당 작업 버튼은 이후 더 길고 강하게 강조됩니다.
- **대기열 진행 펄스:** Codex가 다음 대기 명령을 시작해 `+N`이 줄어들 때도 한 차례의 답변 완료로 인식해 펄스로 알립니다.

## 빠른 설치

### 준비물

- macOS 13 이상. 선택 기능인 CodexBar는 현재 macOS 14 이상이 필요합니다.
- Stream Deck 7.4 이상.
- Stream Deck Neo.
- 번들 식별자가 `com.openai.codex`인 Codex Desktop.

### 설치 순서

1. [릴리스 페이지](https://github.com/y5862000/threaddeck-for-codex/releases)에서 `com.yechan.threaddeck.streamDeckPlugin`을 받습니다. 베타는 Pre-release로 표시됩니다.
2. 파일을 더블클릭하고 Stream Deck에서 설치를 승인합니다.
3. 안내가 나오면 **ThreadDeck for Codex** Neo 프로필을 가져옵니다.
4. **시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용**에서 **Stream Deck**을 허용합니다. 키보드·미디어 동작과 로컬 대기열 감지에 필요합니다.
5. Codex Desktop의 **설정 → 키보드 단축키**에서 아래 단축키를 확인하고, 특히 음성 입력을 `⌃⇧D`로 직접 지정합니다.
6. Codex Desktop을 열고 작업 버튼과 마이크 버튼을 눌러 각각 이동과 음성 입력이 되는지 확인합니다.

### 필수 Codex 단축키 설정

현재 베타는 다음 키 조합을 고정으로 보냅니다. Codex의 단축키가 다르면 해당 ThreadDeck 버튼이 작동하지 않습니다. Codex 버전과 표시 언어에 따라 설정 항목 이름은 조금 다를 수 있습니다.

| Codex 기능 | ThreadDeck이 보내는 키 | 사용하는 버튼 |
|---|---:|---|
| 음성 입력 / 누르는 동안 말하기 | `⌃⇧D` | 전용 마이크 버튼, 작업 버튼 길게 누르기 |
| 프로젝트 밖에 새 작업 열기 | `⌥⌘O` | 새 작업 버튼 |
| 사이드챗 열기 | `⌥⌘S` | 사이드챗 버튼 |

> [!IMPORTANT]
> 음성 입력은 자동으로 설정되지 않습니다. Codex에서 `Control+Shift+D`를 지정한 뒤 사용하세요. ThreadDeck이 라틴 `D`를 명시해 보내므로 2벌식 한글을 비롯한 비라틴 입력 소스가 활성화된 상태에서도 작동합니다. 그래도 반응이 없다면 이 단축키와 Stream Deck의 손쉬운 사용 권한을 먼저 확인하세요.

공개 플러그인은 별도 식별자를 사용하므로 제작자의 비공개 개발용 프로토타입을 덮어쓰지 않습니다.

### 선택 기능: 주간 한도 링

ThreadDeck은 주간 한도 버튼에만 [CodexBar](https://github.com/steipete/CodexBar)를 사용합니다. 그 외 모든 기능은 CodexBar 없이 작동합니다.

```sh
brew install --cask codexbar
codexbar usage --format json
```

CodexBar를 한 번 실행해 제공자 설정에서 Codex를 켜고, 위 명령이 JSON을 반환하는지 확인하세요. 일반적인 Homebrew 설치 위치는 자동으로 찾습니다. 사용자 지정 위치일 때만 `CODEXBAR_PATH`를 설정하면 됩니다.

## 액션과 기본 단축키

| 액션 | 기본 동작 |
|---|---|
| 작업 열기 | 로컬 작업은 짧게 누르면 `codex://`로 엽니다. 원격 작업은 Codex 사이드바 또는 통합 검색에서 정확한 결과를 선택해 해당 작업의 컴퓨터를 먼저 활성화합니다. 0.55초 이상 누르면 작업을 연 뒤 음성 입력을 시작하고, 버튼을 놓으면 녹음을 끝내 받아쓰기가 안정될 때까지 기다렸다가 일반 후속 요청으로 자동 제출합니다. |
| 새 작업 | `⌥⌘O`를 보내 현재 프로젝트 밖에 새 작업을 엽니다. |
| 사이드챗 | `⌥⌘S`를 보냅니다. |
| 누르는 동안 음성 입력 | Stream Deck 버튼을 누르는 동안만 `⌃⇧D`를 홀드합니다. 소리를 출력 중인 앱을 잠시 멈추고 버튼을 놓으면 다시 시작합니다. |
| 보내기 | 짧게 누르면 Return, 0.6초 이상 누른 뒤 놓으면 Command+Return을 보냅니다. 길게 누르기 동작이 준비되면 버튼이 파란색으로 바뀝니다. |
| 앱 전환 | Command를 누른 채 Tab을 입력해 macOS 앱 전환기를 엽니다. |
| 미디어 | 이전/다음, 탐색, 재생/일시정지, 음소거, 음량 조절 액션을 제공합니다. |

작업 버튼 음성 입력은 전용 마이크 버튼과 선택한 작업 카드에 녹음·받아쓰기·제출·성공·오류 상태를 함께 표시합니다. 작업 버튼을 짧게 누르는 기존 이동 동작은 그대로 유지됩니다. 사이드챗은 임시 작업으로 취급되어 열려 있는 동안에는 모니터링되고, Codex에서 닫으면 작업 슬롯에서도 사라집니다.

Codex 단축키를 직접 바꿨다면 `native/keybridge.m`의 해당 상수를 수정한 뒤 다시 빌드해야 합니다. 사용자 설정 가능한 단축키는 이후 베타에서 지원할 예정입니다.

## 로컬 우선 설계

ThreadDeck에는 계정, 원격 서버, 텔레메트리, 분석 도구, 클라우드 백엔드가 없습니다.

| 데이터 소스 | 접근 방식 | 목적 |
|---|---|---|
| `~/.codex` 아래 Codex 파일과 Desktop 로그 | 읽기 전용 | 로컬 작업과 캐시된 원격 작업의 제목·호스트·고정·상태·활동·시간·서비스 메타데이터, 임시 사이드챗 수명 주기. |
| CodexBar CLI | 선택적 하위 프로세스 | 남은 주간 한도만 확인. |
| Stream Deck 플러그인 WebSocket | 로컬호스트 | 버튼 이벤트 수신과 렌더링 이미지 전송. |
| macOS 손쉬운 사용 / Core Audio | 로컬 시스템 API | 단축키, 미디어 키, 음성 입력 중 오디오 처리, 화면에 보이는 Codex 대기열 액션 개수 확인. |

대기열 감지와 원격 작업 선택은 네이티브 헬퍼 안에서 제목 지문을 비교합니다. 원격 제목은 명령행 인수가 아니라 표준 입력으로 Codex 검색에 전달합니다. 대기 메시지 본문은 반환·기록·저장하지 않습니다. Codex 데이터베이스나 세션 파일에는 절대 쓰지 않습니다. 이슈에 로그나 화면을 첨부하기 전에 [보안과 개인정보 보호 안내](SECURITY.ko.md)를 읽어주세요.

## 완전한 오픈소스

ThreadDeck 구현 전체를 [MIT 라이선스](LICENSE)로 공개합니다.

- 외부 런타임 의존성 없는 Node.js 플러그인 소스;
- 범용 macOS 키보드·미디어 헬퍼의 Objective-C 소스;
- 압축을 풀어 둔 Stream Deck Neo 프로필 원본;
- 직접 제작한 ThreadDeck 마크와 실제 렌더러로 생성한 문서 이미지;
- 빌드, 감사, 검증, 패키징, 문서 이미지 생성 스크립트.

릴리스 패키지는 이 저장소만으로 재현할 수 있습니다. 다만 Codex Desktop과 Stream Deck은 실행에 필요한 외부 상용 앱이며 이 저장소에 포함되지 않고 MIT 라이선스 적용 대상도 아닙니다. 정확한 소스·산출물 대응 관계는 [오픈소스 구성표](docs/OPEN_SOURCE.ko.md)에 정리했습니다.

## 소스에서 빌드

Node.js 20 이상, pnpm, Xcode Command Line Tools, Stream Deck을 설치한 뒤 실행합니다.

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run audit
pnpm run check
pnpm run pack
```

설치 파일은 `release/`에 생성됩니다. 네이티브 헬퍼는 `native/keybridge.m`에서 Apple Silicon과 Intel을 모두 지원하는 범용 바이너리로 빌드됩니다. README 이미지는 실제 버튼 렌더러에서 다시 만들 수 있습니다.

```sh
pnpm run render-docs
pnpm run render-animation
```

애니메이션 생성에는 macOS의 `sips`, Swift, ImageIO만 사용하므로 별도 GIF 인코더가 필요하지 않습니다.

데이터 흐름은 [구조 설명](docs/ARCHITECTURE.ko.md), 개발 방법은 [기여 안내](CONTRIBUTING.ko.md)를 참고하세요.

## 현재 제한사항

- 첫 공개 베타는 macOS와 Stream Deck Neo만 지원합니다.
- 버튼 UI는 한국어 우선입니다.
- 작업·사이드챗 감지는 Codex의 비공개 파일 및 로그 형식에 의존하므로 Codex 업데이트 직후 일시적으로 어긋날 수 있습니다.
- 대기 개수는 현재 열려 있는 Codex 작업에서 관찰한 뒤 해당 버튼에 유지합니다. 첫 버전은 한국어·영어 Codex 접근성 라벨을 인식합니다.
- 현재 단축키 액션은 위에 적힌 Codex 기본 단축키를 전제로 합니다.
- 주간 한도 링은 별도로 설치한 CodexBar가 필요합니다.
- Elgato 앱 실행 버튼은 원래 렌더링과 동작을 유지해 ThreadDeck 완료 효과가 적용되지 않습니다. 기본 프로필의 이전 페이지 버튼은 ThreadDeck 액션이라 완료 효과가 적용됩니다.

문제가 있으면 먼저 [문제 해결 가이드](docs/TROUBLESHOOTING.ko.md)를 확인한 뒤, 저장소의 이슈 양식을 사용해주세요.

## 비슷한 프로젝트

Codex와 Stream Deck을 연결한 프로젝트는 ThreadDeck이 처음은 아닙니다. [Codex Deck](https://github.com/dazer1234/codex-stream-deck)은 Codex Micro 제어에 강점이 있고, 여러 오픈소스·Marketplace 플러그인은 AI 사용량 확인에 집중합니다. ThreadDeck은 실제 Neo에서 검증한 Codex Desktop 작업 대시보드라는 더 좁은 목표를 갖습니다. 자세한 비교는 [관련 프로젝트](docs/ALTERNATIVES.ko.md)에 있습니다.

## 프로젝트 문서

- [브랜드 가이드](docs/BRAND.ko.md) · [English](docs/BRAND.md)
- [오픈소스 구성표](docs/OPEN_SOURCE.ko.md) · [English](docs/OPEN_SOURCE.md)
- [구조 설명](docs/ARCHITECTURE.ko.md) · [English](docs/ARCHITECTURE.md)
- [문제 해결](docs/TROUBLESHOOTING.ko.md) · [English](docs/TROUBLESHOOTING.md)
- [관련 프로젝트](docs/ALTERNATIVES.ko.md) · [English](docs/ALTERNATIVES.md)
- [기여 안내](CONTRIBUTING.ko.md) · [English](CONTRIBUTING.md)
- [보안과 개인정보 보호](SECURITY.ko.md) · [English](SECURITY.md)
- [지원 안내](SUPPORT.ko.md) · [English](SUPPORT.md)
- [변경 기록](CHANGELOG.ko.md) · [English](CHANGELOG.md)

## 라이선스와 상표

ThreadDeck은 [MIT 라이선스](LICENSE)로 제공됩니다. OpenAI 또는 Elgato와 관련·제휴·후원 관계가 없는 독립 비공식 프로젝트입니다. 상표와 자산 관련 고지는 [한국어 고지](NOTICE.ko.md)를 참고하세요.
