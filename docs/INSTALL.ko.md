# 다른 Mac에 ThreadDeck 설치하기

> [English](INSTALL.md)

ThreadDeck은 하나의 한영 통합 Stream Deck 플러그인으로 배포됩니다. 같은 설치 파일이 Stream Deck 앱 언어가 영어면 영어, 한국어면 한국어를 자동으로 사용하므로 언어별 빌드를 따로 받을 필요가 없습니다.

## 준비 사항

- macOS 13 이상
- Stream Deck 7.4 이상
- Stream Deck Neo
- 번들 ID가 `com.openai.codex`인 Codex Desktop

Apple Silicon과 Intel Mac이 같은 설치 파일을 사용합니다. 다운로드 무결성을 확인하려는 사용자를 위해
각 릴리스에는 `com.yechan.threaddeck.streamDeckPlugin.sha256`도 함께 올라갑니다.

## 설치

1. [GitHub Releases](https://github.com/y5862000/threaddeck-for-codex/releases)에서 `com.yechan.threaddeck.streamDeckPlugin`을 받습니다.
2. 파일을 두 번 클릭하고 Stream Deck에서 설치를 승인합니다.
3. Stream Deck의 프로필 선택기에서 **ThreadDeck for Codex**를 선택합니다. 현재 프로필을 덮어쓰지 않고 별도로 설치됩니다.
4. **시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용**에서 **Stream Deck**을 허용한 뒤 Stream Deck을 완전히 종료하고 다시 엽니다.
5. **Codex → 설정 → 키보드 단축키**에서 다음 값을 지정하거나 확인합니다.

| Codex 기능 | 단축키 |
|---|---:|
| 음성 입력 시작 | `Control+Shift+D` (`⌃⇧D`) |
| 프로젝트 밖 새 작업 | `Option+Command+O` (`⌥⌘O`) |
| 사이드챗 열기 | `Option+Command+S` (`⌥⌘S`) |

6. 마이크 버튼을 누른 채 말한 뒤 놓습니다. 처음에는 Codex가 마이크 권한을 요청할 수 있습니다.

화면 기록과 전체 디스크 접근 권한은 필요하지 않습니다. 선택적인 사용량 버튼만 [CodexBar](https://github.com/steipete/CodexBar)가 필요하고, 나머지 기능은 단독으로 동작합니다.

## 버튼에 설정 경고가 뜨는 경우

ThreadDeck은 시작할 때와 30초마다 손쉬운 사용 및 키보드 이벤트 권한을 확인합니다. 권한이 없으면 macOS 공식 요청을 띄우고 복구될 때까지 버튼에 짧은 경고를 유지합니다.

소스 체크아웃에서는 `pnpm run doctor`로 읽기 전용 설치 진단을 실행할 수 있습니다. 자세한 해결법은 [문제 해결](TROUBLESHOOTING.ko.md)을 확인하세요.

## 업데이트 또는 삭제

- 업데이트는 새 `.streamDeckPlugin` 파일을 기존 설치 위에 설치하면 됩니다.
- 삭제는 Stream Deck 플러그인 목록에서 **ThreadDeck for Codex**를 우클릭하고 **제거**를 선택합니다. Codex 데이터는 수정되지 않습니다.
