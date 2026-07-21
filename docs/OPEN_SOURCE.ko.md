# 오픈소스 구성표

> [English](OPEN_SOURCE.md)

ThreadDeck 구현 전체는 [MIT 라이선스](../LICENSE)로 공개됩니다. 이 문서는 저장소가 소유한 원본, 생성 산출물, 선택 도구, 독점 런타임 앱의 경계를 분명히 설명합니다.

## 원본과 산출물

| 원본 | 생성 산출물 | 빌드 단계 |
|---|---|---|
| 최상위 `src/*.js` 모듈 | 바이트 단위로 그대로 복사한 대응 `com.yechan.threaddeck.sdPlugin/bin/*.js` 모듈 | `scripts/build.sh` |
| `native/keybridge.m` | 범용 `com.yechan.threaddeck.sdPlugin/bin/keybridge` | `scripts/build-bridge.sh` |
| `profiles/source/unpacked/` | 포함되는 `.streamDeckProfile` 압축 파일 | `scripts/build-profile.sh` |
| `assets/plugin.svg` | 플러그인 PNG 자산 | `scripts/build-assets.sh` |
| `src/plugin.js`의 실제 버튼 렌더링 함수 | `docs/media/neo-preview*`와 기능 PNG | `scripts/render-docs.mjs` |
| 결정론적 개요·제스처 프레임과 `scripts/encode-gif.swift` | `docs/media/threaddeck-overview.gif`, 작업 버튼 음성 입력, 전용 마이크 홀드, 보내기 길게 누르기, 중립 앱 실행 안내 GIF | `scripts/render-animation.mjs` |
| 플러그인 디렉터리 | `.streamDeckPlugin` 설치 파일 | `pnpm run pack` |

생성된 `bin/`, 프로필 압축 파일, 릴리스 설치 파일은 위 원본에서 다시 만들 수 있어 Git에서 제외합니다. 검증 과정은 번들된 모든 JavaScript 모듈을 원본과 바이트 단위로 비교하고, 빠졌거나 원본이 없는 과거 모듈을 거부합니다. 문서 PNG와 GIF는 플러그인을 실행하지 않은 GitHub 방문자도 인터페이스를 볼 수 있도록 추적합니다. ThreadDeck 버튼 그림은 배포 렌더러에서 나오며 집중 GIF에는 설명용 타임라인만 추가합니다. 앱 실행 GIF는 실제 런처와 그림이 Stream Deck 소유이므로 중립적인 안내 버튼을 사용합니다.

## 의존성 경계

- 런타임 Node.js 플러그인은 Node 기본 모듈만 사용합니다.
- `@elgato/cli`는 검증·패키징용 개발 의존성입니다. MIT 라이선스이며 앱 동작 코드에 포함되지 않습니다.
- `sharp`는 저장소 소유 SVG를 플러그인·문서 PNG로 바꾸기 위해 `scripts/rasterize.mjs`에서만 사용하는 개발 의존성입니다. Sharp와 플랫폼별 패키지는 빌드 도구이며 런타임 플러그인에는 포함되지 않습니다. Darwin용 `@img/sharp-libvips-*` 1.2.4 빌드 패키지는 `LGPL-3.0-or-later`를 사용하며, 라이선스 감사는 LGPL 전체를 허용하지 않고 Sharp가 개발 의존성인 동안 해당 패키지명과 정확한 버전에만 예외를 적용합니다.
- [CodexBar](https://github.com/steipete/CodexBar)는 한도 데이터에만 쓰는 선택적 별도 MIT 라이선스 실행 파일입니다.
- Xcode Command Line Tools와 macOS 시스템 프레임워크가 네이티브 헬퍼를 빌드하고 실행합니다.

## 외부 독점 앱

플러그인을 사용하려면 Codex Desktop과 Stream Deck이 필요합니다. 두 앱은 이 저장소에서 재배포하지 않는 외부 독점 앱이며 ThreadDeck MIT 라이선스 대상이 아닙니다. 이 요구사항이 ThreadDeck 원본을 숨기는 것은 아닙니다. 이 플러그인을 위해 작성된 구성 요소는 모두 저장소에 있습니다.

## 연구용 원본 스냅샷

`reference/codex-micro-protocol/`에는
[`mpociot/codex-micro-stream-deck-emulator`](https://github.com/mpociot/codex-micro-stream-deck-emulator)의
`7093bd48f0bcb953f623b40c727470e545b48df3` 커밋에서 선별한 파일을 바이트 단위로 그대로
보존합니다. 프로토콜·프레이밍·상태 카탈로그·루프백 전송·테스트 원본은 Marcel Pociot의
MIT 라이선스를 따르며, 바로 옆 `LICENSE.upstream`에 원문을 포함했습니다. ThreadDeck에서
추가한 출처 설명, 체크섬, 패키지 골격은 복사된 원본과 구분합니다.

이 참고 코드는 `src/`에서 불러오지 않고 플러그인이나 릴리스 설치 파일에도 포함하지 않습니다.
프로세스 주입 shim, 가상 HID helper, 별도 하드웨어 백엔드, 렌더러, 원본 미디어 자산은
의도적으로 가져오지 않았습니다.

## 런타임 렌더러 연결 출처

`src/micro-cdp.js`와 `src/micro-bootstrap.js`는
[`dazer1234/codex-stream-deck`](https://github.com/dazer1234/codex-stream-deck)의
`src/codex-micro-renderer-bridge.ts`, `launcher/runtime-override.ts`를 중심으로 루프백 CDP 대상
선택, Codex Micro 렌더러 이벤트, 기능 활성화 방식을 적용·수정했습니다.
Copyright (c) 2026 Dazer, MIT 라이선스입니다.

ThreadDeck은 이를 외부 의존성 없는 CommonJS로 다시 구성하고 첫 세션 보존, 프로세스 세대별
복구, 개인정보 제한 읽기 전용 스냅샷, Micro 6개와 ThreadDeck 8개 작업 결합, 중복 실행을 막는
폴백 계약을 추가했습니다. Codex Deck의 UI·미디어·세션 소유권 계층·하드웨어 백엔드는 복사하지
않았습니다. 전체 원본 라이선스는 `reference/codex-deck/LICENSE.upstream`에 보존하고 모든
플러그인 설치 파일 안에도 `licenses/codex-deck-MIT.txt`로 포함합니다.

## 재현 가능한 검증

호환되는 Mac에서 다음을 실행합니다.

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run audit
pnpm run check
pnpm run pack
```

릴리스 감사는 개인 경로, 하드웨어 식별자, 비밀값, 독점 글꼴 파일, 과거 비공개 식별자, 실수로 복사한 제공자 자산을 거부합니다. 별도 의존성 감사는 검토한 허용 라이선스 목록 밖의 라이선스가 들어오면 실패합니다. CI는 모든 push와 Pull Request에서 같은 빌드·검증 경로를 실행합니다.

## 기여와 포크

MIT 라이선스의 저작권·라이선스 고지를 지키면 복사본을 사용·수정·배포·재라이선스·판매할 수 있습니다. ThreadDeck 프로젝트명과 타사 제품명을 보증 관계를 암시하는 방식으로 사용해서는 안 됩니다. [브랜드 가이드](BRAND.ko.md)와 [고지](../NOTICE.ko.md)를 참고하세요.
