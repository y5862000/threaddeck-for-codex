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
| 결정론적 개요·제스처 프레임과 `scripts/encode-gif.swift` | `docs/media/threaddeck-demo.gif`, 작업 버튼 음성 입력, 전용 마이크 홀드, 보내기 길게 누르기, 중립 앱 실행 안내 GIF | `scripts/render-animation.mjs` |
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
