# 문제 해결

> [English](TROUBLESHOOTING.md)

## 한도 버튼에 숫자가 없습니다

CodexBar를 설치하고 터미널에서 `codexbar usage --format json`이 작동하는지 확인합니다. 플러그인은 `CODEXBAR_PATH`, `~/.local/bin/codexbar`, `/opt/homebrew/bin/codexbar`, `/usr/local/bin/codexbar`, 프로세스 `PATH` 순서로 찾습니다.

## 단축키 또는 음성 입력이 작동하지 않습니다

**시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용**에서 **Stream Deck**을 허용합니다. 권한을 바꾼 뒤 Stream Deck을 완전히 종료하고 다시 엽니다.

작업 버튼 음성 입력은 말하는 동안 작업 버튼을 계속 누르고 있어야 합니다. 버튼을 놓으면 녹음이 끝나고, ThreadDeck이 Codex 받아쓰기가 안정될 때까지 기다린 뒤 일반 후속 요청을 제출합니다. 오류가 표시되면 Codex 음성 입력 단축키가 `Control+Shift+D`인지, 메시지 입력 영역이 화면에 보이는지 확인합니다.

## 작업 카드가 비어 있습니다

Codex Desktop을 열고 작업을 하나 이상 만듭니다. Codex 업데이트로 로컬 데이터베이스 형식이 바뀌었다면 작업 제목·세션 내용이 포함되지 않은 Stream Deck 플러그인 로그를 수집해 이슈를 열어주세요.

## 대기열 배지가 나타나지 않습니다

Codex에서 해당 작업을 열어 대기열이 화면에 보이게 하고, Stream Deck 손쉬운 사용 권한을 확인합니다. ThreadDeck은 현재 열린 Codex 작업의 대기 동작만 관찰한 뒤 개수를 해당 작업 버튼에 유지합니다. 첫 공개 버전은 한국어·영어 Codex 손쉬운 사용 라벨을 인식합니다.

## 닫은 사이드챗이 잠깐 다시 나타납니다

최신 베타로 업데이트합니다. ThreadDeck은 임시 사이드챗을 현재 Codex App Server 세션 범위로 제한하고, 상태 파일을 다시 쓰는 짧은 순간에도 닫힘 기록을 유지합니다. 계속 나타난다면 Codex·ThreadDeck 버전을 이슈에 적되 Desktop 로그나 실제 작업 제목은 첨부하지 마세요.

## 화면 모드가 잘못 표시됩니다

ThreadDeck은 2초마다 시스템 화면 모드를 따릅니다. 디버깅할 때는 Stream Deck을 `THREADDECK_APPEARANCE=dark` 또는 `THREADDECK_APPEARANCE=light` 환경 변수와 함께 실행할 수 있습니다.

## Codex 데이터 위치를 바꿨습니다

`CODEX_HOME`을 설정하거나 `THREADDECK_STATE_DB`, `THREADDECK_GLOBAL_STATE`, `THREADDECK_SESSION_INDEX`, `THREADDECK_PROCESS_REGISTRY`로 각 경로를 지정합니다.
