# Stream Deck Neo 추천 프로파일

> [English](PROFILE.md)

ThreadDeck은 8키 **Stream Deck Neo**에 맞춘 편집 가능한 Codex 전용 2페이지 프로파일 하나를 제공합니다. Stream Deck 프로파일 메뉴에는 **ThreadDeck for Codex**라는 이름으로 표시됩니다.

![Stream Deck Neo용 ThreadDeck for Codex 추천 대시보드](media/neo-preview.png)

## 프로파일 받기

권장 방식은 [GitHub Releases](https://github.com/y5862000/threaddeck-for-codex/releases)의 `com.yechan.threaddeck.streamDeckPlugin`을 설치하는 것입니다. 플러그인이 현재 사용 중인 프로파일을 덮어쓰지 않고 이 추천 프로파일을 자동으로 설치합니다.

릴리스 파이프라인은 복구·수동 가져오기·편집 가능한 두 번째 복사본을 위한 `threaddeck-for-codex-neo.streamDeckProfile`도 별도 파일로 만듭니다. 독립 프로파일의 Codex 액션을 실행하려면 ThreadDeck 플러그인은 여전히 설치되어 있어야 합니다.

> [!NOTE]
> 프로파일 메뉴에 **ThreadDeck for Codex**가 이미 있으면 의도적으로 복제할 때가 아니라면 독립 파일을 다시 가져오지 마세요. 예전 실험용 **Codex Neo** 프로파일을 함께 둘 수는 있지만, 현재 유지되는 추천 프로파일은 아닙니다.

## 1페이지 — 대시보드

| 주간 한도 | 새 작업 | 사이드챗 | 보내기 |
|---|---|---|---|
| 현재 작업 | Effort + Fast | 마이크 | 페이지 전환(이전) |

평소 사용하는 추천 페이지입니다. Codex에서 선택한 작업을 확인하고, 다음 응답의 Effort/Fast를 정하고, 페이지 이동 없이 받아쓰기와 전송을 할 수 있습니다.

위쪽의 작업 흐름 키 3개는 같은 **Codex 명령** 액션을 새 작업·사이드챗·보내기로 각각 설정한 것입니다. 현재 작업 키는 설정 가능한 **Codex 작업** 액션을 사용합니다.

## 2페이지 — 작업

| 상위 작업 1 | 상위 작업 2 | 상위 작업 3 | 상위 작업 4 |
|---|---|---|---|
| 상위 작업 5 | 상위 작업 6 | 상위 작업 7 | 페이지 전환(이전) |

이 페이지의 모든 작업 키도 같은 **Codex 작업** 액션이며 속성 검사기에서 상위 1~7을 각각 선택했습니다. 사용자 지정 배치에서는 복사본 하나를 더 놓고 상위 8을 고르면 됩니다.

## 안전하게 바꾸기

- 큰 재배치 전에는 Stream Deck에서 프로파일을 복제하세요.
- 버튼을 선택한 뒤 자동 저장 속성 검사기에서 작업 위치나 명령을 바꾸세요.
- 두 페이지를 유지한다면 ThreadDeck의 **페이지 전환** 키를 남겨 두세요. 이 키는 ThreadDeck 액션 목록에서도 다시 추가할 수 있고 이전·다음 방향을 고를 수 있으며, Stream Deck 기본 탐색 액션과 달리 라이트·다크 화면 모드를 따릅니다.
- 프로파일 원본은 하드웨어 UUID를 포함하지 않으며 [`profiles/source/unpacked`](../profiles/source/unpacked)에 있습니다.
- 릴리스 감사가 공개 전에 Neo 모델과 추천 키 좌표를 모두 검증합니다.
