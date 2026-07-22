# 기여 안내

> [English](../.github/CONTRIBUTING.md)

ThreadDeck을 개선해주셔서 감사합니다. 하드웨어 작업 흐름은 작은 변화도 체감이 크므로, 범위가 작고 목적이 분명한 Pull Request가 검토하기 쉽고 안전합니다.

## 시작하기 전에

- 기존 이슈와 Pull Request를 먼저 검색해주세요.
- 사용자가 느끼는 동작을 바꾸려면 기능 요청을 먼저 열고 Stream Deck 모델, 페이지, 기대 동작을 설명해주세요.
- 실제 `~/.codex` 데이터베이스·세션 파일·액세스 토큰·기기 일련번호·비공개 작업 제목이 담긴 화면을 첨부하지 마세요.
- OpenAI·Elgato 로고, 독점 글꼴, 복사한 제품 자산을 추가하지 마세요. [브랜드 가이드](BRAND.ko.md)를 따릅니다.

## 개발 환경

macOS, Node.js 20 이상, pnpm, Xcode Command Line Tools, Stream Deck 7.4 이상, Stream Deck Neo, Codex Desktop이 필요합니다.

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run check
```

`pnpm run build`는 범용 네이티브 헬퍼를 컴파일하고 최상위 `src/*.js` 모듈을 각각 대응하는 플러그인 `bin/*.js` 경로로 바이트 단위 변형 없이 복사하며, 빌드 전용 Sharp 의존성으로 플러그인 SVG 자산을 래스터화한 뒤 배포용 프로필을 만듭니다. `pnpm run test`는 Node 기본 테스트 실행기로 I/O 없는 파서·정책 계약을 검사합니다. `pnpm run check`는 이 테스트를 다시 실행하고 누락되거나 원본이 없는 JavaScript 모듈 없이 원본·번들 바이트 일치를 확인하며, 인라인 런타임 계약, JSON, 두 CPU 아키텍처의 헬퍼, Stream Deck manifest, 문서, 공개 릴리스 개인정보 감사를 검증합니다.

설치 파일을 만들려면 다음을 실행합니다.

```sh
pnpm run pack
```

패키징은 정확한 임시 스테이징 복사본을 사용하므로 Stream Deck 패커의 manifest 정규화가 검증된 플러그인 디렉터리를 수정하지 않습니다.

실제 버튼 렌더러에서 문서 이미지와 GIF를 다시 만들려면 다음을 실행합니다.

```sh
pnpm run render-docs
pnpm run render-animation
```

두 명령 모두 자산 빌드와 같은 Sharp 기반 SVG 래스터화 도구를 사용합니다. Sharp는 `pnpm install`로 설치되며 배포되는 플러그인 런타임에는 들어가지 않습니다. GIF 인코딩에는 저장소의 Swift·ImageIO 헬퍼도 사용합니다.

## 프로젝트 경계

1. 네이티브 브리지와 모든 로컬 데이터 소스를 다른 운영체제용으로 구현하기 전까지 플러그인은 macOS 전용으로 유지합니다.
2. `~/.codex` 아래 파일은 언제든 바뀔 수 있는 읽기 전용 구현 세부사항으로 취급합니다. 필드가 없어도 안전하게 실패해야 합니다.
3. 위험이나 유지보수 비용을 명확히 줄이지 않는다면 런타임 Node.js 플러그인에는 의존성을 추가하지 않습니다.
4. Elgato 기본 탐색·앱 액션을 보존하고 사용자 프로필에서 삭제하거나 강제로 대체하지 않습니다.
5. 실제 144 × 144 버튼에서 글자가 읽히는지 확인합니다. 큰 미리보기만 보고 판단하지 않습니다.
6. 라이트·다크 모드는 같은 기능과 정보 구조를 제공해야 합니다.

## Pull Request 확인 목록

- `pnpm run build`, `pnpm run test`, `pnpm run audit`, `pnpm run check`를 실행합니다.
- 최상위 `src/*.js` 모듈을 추가하거나 이름을 바꾸면 빌드가 같은 이름의 바이트 단위 동일한 `bin/*.js` 모듈을 만들고 과거 번들 이름을 제거하는지 확인합니다.
- 테스트한 macOS, Stream Deck 소프트웨어, Stream Deck 모델, Codex 버전을 적습니다.
- 시각 변경에는 개인정보를 제거한 전후 사진 또는 생성된 버튼 렌더를 첨부합니다.
- 공개 동작이 바뀌면 영어 README와 한국어 README를 함께 갱신합니다.
- 사용자에게 보이는 수정이나 기능은 변경 기록에 추가합니다.

기여물을 제출하면 저장소의 [MIT 라이선스](../LICENSE)로 배포될 수 있음에 동의하게 됩니다.
