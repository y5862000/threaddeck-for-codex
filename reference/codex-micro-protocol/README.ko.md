# Codex Micro 프로토콜 참고 스냅샷

> [English reference notes](README.md)

이 디렉터리는
[`mpociot/codex-micro-stream-deck-emulator`](https://github.com/mpociot/codex-micro-stream-deck-emulator)의
[`7093bd4`](https://github.com/mpociot/codex-micro-stream-deck-emulator/tree/7093bd48f0bcb953f623b40c727470e545b48df3)
커밋에서 향후 ThreadDeck 리팩터링에 참고할 만한 순수 프로토콜 계층만 고정해 둔 연구용
스냅샷입니다. 선택한 원본 파일은 바이트 단위로 같고, `package.json`, 두 README,
`UPSTREAM.sha256`만 ThreadDeck에서 덧붙였습니다.

가져온 핵심은 64바이트 HID 프레이밍, 전송과 상태 머신의 분리, 메모리 루프백 테스트,
Codex Micro 상태 색상과 명령 카탈로그입니다. 반면 ChatGPT 프로세스 주입 shim, 앱 재실행
스크립트, 제한된 Apple 권한이 필요한 가상 HID helper, 별도 Stream Deck 하드웨어 백엔드와
이미지 자산은 의도적으로 제외했습니다.

이 코드는 현재 플러그인에 연결되지 않고 설치 파일에도 들어가지 않습니다. 나중에 구조를
정리할 때 전송 계층과 테스트 패턴을 ThreadDeck 코드로 옮겨 쓰기 위한 참고 자료이며,
비공개 프로토콜 값은 그 시점의 Codex 버전에서 다시 검증해야 합니다. 복사된 파일의 저작권과
MIT 조건은 `LICENSE.upstream`을 따릅니다.

보존한 파일은 아래 명령으로 검증합니다.

```sh
cd reference/codex-micro-protocol
shasum -a 256 -c UPSTREAM.sha256
node --test test/*.mjs
```
