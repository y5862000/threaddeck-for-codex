# Stream Deck Neo 추천 프로파일

> [English](PROFILE.md)

ThreadDeck은 8키 **Stream Deck Neo**에 맞춘 편집 가능한 3페이지 프로파일 하나를 제공합니다. Stream Deck 프로파일 메뉴에는 **ThreadDeck for Codex**라는 이름으로 표시됩니다.

![Stream Deck Neo용 ThreadDeck for Codex 추천 대시보드](media/neo-preview.png)

## 프로파일 받기

권장 방식은 [GitHub Releases](https://github.com/y5862000/threaddeck-for-codex/releases)의 `com.yechan.threaddeck.streamDeckPlugin`을 설치하는 것입니다. 플러그인이 현재 사용 중인 프로파일을 덮어쓰지 않고 이 추천 프로파일을 자동으로 설치합니다.

각 릴리스에는 `threaddeck-for-codex-neo.streamDeckProfile`도 별도 파일로 첨부됩니다. 추천 배치를 복구하거나, 편집할 두 번째 복사본을 만들거나, 플러그인을 다시 설치하지 않고 프로파일만 확인할 때 사용하세요. 독립 프로파일의 Codex 액션을 실행하려면 ThreadDeck 플러그인은 여전히 설치되어 있어야 합니다.

> [!NOTE]
> 프로파일 메뉴에 **ThreadDeck for Codex**가 이미 있으면 의도적으로 복제할 때가 아니라면 독립 파일을 다시 가져오지 마세요. 예전 실험용 **Codex Neo** 프로파일을 함께 둘 수는 있지만, 현재 유지되는 추천 프로파일은 아닙니다.

## 1페이지 — 대시보드

| 주간 한도 | 새 작업 | 사이드챗 | 보내기 |
|---|---|---|---|
| 현재 작업 | Effort + Fast | 마이크 | 이전 페이지 |

평소 사용하는 추천 페이지입니다. Codex에서 선택한 작업을 확인하고, 다음 응답의 Effort/Fast를 정하고, 페이지 이동 없이 받아쓰기와 전송을 할 수 있습니다.

## 2페이지 — 작업

| 상위 작업 1 | 상위 작업 2 | 상위 작업 3 | 상위 작업 4 |
|---|---|---|---|
| 상위 작업 5 | 상위 작업 6 | 상위 작업 7 | 이전 페이지 |

`상위 작업 8`은 사용자 지정 배치용 ThreadDeck 액션 목록에 남아 있습니다. 별도의 현재 작업 액션은 의도적으로 대시보드에 둡니다.

## 3페이지 — 미디어와 앱

| 이전 트랙 | 되감기 | 재생/일시정지 | Codex |
|---|---|---|---|
| Stream Deck | 음악 | Chrome | 이전 페이지 |

앱 실행 버튼 4개는 Elgato의 편집 가능한 **응용 프로그램 열기** 액션입니다. 선호하는 앱이 다르면 Stream Deck에서 바꾸거나 삭제하세요. ThreadDeck 소유 미디어·페이지 버튼에는 전체 완료 효과가 계속 적용됩니다.

## 안전하게 바꾸기

- 큰 재배치 전에는 Stream Deck에서 프로파일을 복제하세요.
- 여러 페이지를 유지한다면 이전/다음 페이지 액션을 하나 이상 남기세요.
- 프로파일 원본은 하드웨어 UUID를 포함하지 않으며 [`profiles/source/unpacked`](../profiles/source/unpacked)에 있습니다.
- 릴리스 감사가 공개 전에 Neo 모델과 추천 키 좌표를 모두 검증합니다.
