# 플랫폼 이식 안내

> [English](PORTING.md)

ThreadDeck 0.4는 macOS만 지원합니다. 플러그인 프로토콜, 작업 선택, 렌더러, 영어/한국어 현지화, 대부분의 수명주기 리듀서는 이식 가능하지만 Codex와 미디어를 조작하는 네이티브 계층은 macOS 전용입니다.

## 현재 이식 경계

| 계층 | 현재 공통 사용 가능 | 현재 플랫폼 전용 |
|---|---|---|
| Stream Deck WebSocket과 액션 UUID | 가능 | 프로필·기기 검증은 현재 Neo 대상 |
| SVG 버튼 렌더러와 영어/한국어 문구 | 가능 | 시스템 테마 확인은 macOS `defaults` 사용 |
| Codex 수명주기·대기열·목표·작업 선택 | 대부분 가능 | 로컬 파일·DB 경로는 macOS Codex Desktop 기준 |
| 사용자 동작 | 의도와 결과 처리는 공통 | `native/keybridge.m`은 macOS 손쉬운 사용·Core Audio·합성 키 입력 사용 |
| 패키징 | Elgato `.streamDeckPlugin` | manifest에는 현재 `mac`만 선언 |

`src/runtime-info.js`가 Stream Deck 언어·플랫폼·기능을 받는 작은 등록 경계이고, `src/i18n.js`가 도메인 활동 코드를 화면 언어와 분리합니다. Windows 이식은 `src/plugin.js` 곳곳에 조건문을 추가하기보다 검증 결과가 같은 플랫폼 어댑터를 추가하는 방식이 적합합니다.

## Windows 어댑터 최소 계약

Windows 지원 기여에는 다음 대응 기능이 필요합니다.

1. Codex Desktop 상태와 로그를 쓰지 않고 찾기
2. 현재 Codex 작업과 정확한 작성창 식별
3. 화면 좌표 없이 로컬·원격·사이드챗 대상 열기
4. 음성 입력 key-down/key-up, 보내기, Effort, Fast mode 실행 뒤 결과 검증
5. ThreadDeck이 멈춘 미디어만 다시 재생하는 소유권 기반 일시정지·재개
6. 동일한 지속 경고 UI를 구동할 권한·건강 상태 결과
7. manifest의 Windows 항목과 Windows CI·패키지 테스트

기존 `keybridge`의 표준 출력 형식과 종료 코드가 호환성 경계입니다. 작업 메타데이터는 읽기 전용으로 유지하고 대상 identity나 포커스가 모호하면 실패 폐쇄해야 합니다.

## 언어는 플랫폼 분기가 아닙니다

영어판과 한국어판 플러그인을 따로 만들지 않습니다. Stream Deck이 `application.language`를 제공하면 하나의 런타임이 `en` 또는 `ko`로 정규화하고, `en.json`과 `ko.json`이 액션 목록을 현지화합니다. 추가 플랫폼도 같은 패키지 수준 언어 동작을 재사용해야 합니다.
