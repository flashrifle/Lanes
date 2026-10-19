<p align="center"><img src="design/icon.png" width="128" alt="Lanes"></p>

# Lanes

IDE에 들어 있는 Git 로그 창을 따로 떼어 낸 듯한, 빠르고 가벼운 macOS용 독립 실행형 Git 클라이언트입니다.
IDE를 열지 않고도 커밋 그래프, 브랜치 트리, 필터, 파일 히스토리, blame을 그대로 쓸 수 있고,
커밋·스테이징·push·merge·rebase 같은 일상 작업도 Lanes 안에서 끝낼 수 있습니다.

Tauri 2(Rust) + React + TypeScript로 만들었고, 시스템에 설치된 `git`을 그대로 사용합니다.
무료이며 오픈소스(Apache-2.0)입니다.

## 설치
- **dmg**: [Releases](https://github.com/flashrifle/Lanes/releases/latest)에서 `Lanes_<버전>_universal.dmg`를 받아 응용 프로그램 폴더로 옮깁니다. Apple Silicon과 Intel을 모두 지원하고, Apple 공증을 받았습니다.
- **Homebrew**:
  ```bash
  brew install --cask flashrifle/tap/lanes
  ```
- 새 버전은 앱 안에서 자동으로 알려 주고 설치합니다(설정에서 끌 수 있음).

요구 사항: macOS 11 이상, git 2.23 이상(Xcode 커맨드라인 도구나 Homebrew git).

## 주요 기능

### 히스토리 보기
- **커밋 그래프**: 레인 배치와 "Standard"(Bek) 정렬. IntelliJ Platform의 오픈소스 그래프 엔진을 옮겨 왔습니다. 커밋 10만 개 이상도 부드럽게 표시
- **지하철 노선도 스타일**: 직선과 각진 꺾임, 교차점 외곽선, merge 커밋은 환승역 모양
- **브랜치마다 하나의 노선 색**: 한 줄기는 처음부터 끝까지 같은 색. `main`과 `origin/main`은 같은 색
- **노선 강조**: 그래프의 선이나 브랜치 배지를 클릭하면 그 줄기만 진하게, 나머지는 흐리게
- **필터**: 텍스트/해시(정규식, 대소문자 구분), 브랜치, 사용자, 날짜, 경로. 걸러진 히스토리는 점선으로 연결
- **브랜치 비교**: 두 브랜치 중 한쪽에만 있는 커밋, 양쪽 개수와 merge base
- **파일 히스토리와 blame**: 파일 이름이 바뀌어도 따라가는 히스토리, 줄마다 그 줄을 넣은 커밋. blame에서 클릭하면 그 커밋으로 이동
- **선택한 줄 히스토리**: 몇 줄만 골라 그 부분을 바꾼 커밋만 보기(`git log -L`)
- **Reflog**: 잃어버린 커밋 찾기, 그 지점에서 체크아웃하거나 새 브랜치 만들기
- **좌우 비교 diff 창**: 단어 단위 하이라이트

### 작업
- **커밋하지 않은 변경**: 로그 맨 위 줄에서 Conflicts / Staged / Unstaged / Untracked를 한눈에 보기
- **스테이징**: 파일 단위, 그리고 diff 창에서 hunk·줄 단위 stage / unstage / 변경 취소
- **커밋**: amend, sign-off, 커밋하고 바로 push
- **Push**: 보낼 커밋 미리 보기, upstream 설정, 태그 함께 보내기. 강제 push는 확인을 거친 `--force-with-lease`로만
- **Stash**: 저장(untracked 포함, index 유지, 일부 파일만), apply / pop / drop
- **Merge / Rebase**: 진행 중 상태 표시(단계 N/M), Continue / Skip / Abort, 충돌 파일 Accept Ours/Theirs와 해결됨 표시
- **Cherry-pick / Revert / Reset / 태그**: 커밋 우클릭 메뉴. hard reset은 브랜치 이름을 입력해야 실행
- **작업 버튼 줄**: 페치, 풀 ↓n, 푸시 ↑n, 커밋, Stash, Reflog를 로그 위에서 바로

### 메뉴 막대
- 아이콘 옆에 보낼(↑)·받을(↓) 커밋 수 표시
- 저장소마다 브랜치, 변경 수, 마지막 페치 시각. 창을 열지 않고 풀 / 푸시 / 페치
- **빠른 커밋**: 메뉴 막대 아래 작은 창에서 파일을 골라 커밋하거나 커밋+push
- 메인 창을 닫아도 메뉴 막대에 남기, 백그라운드 페치(15/30/60분) — 설정에서 선택

### 그 밖에
- 여러 저장소를 탭으로 열기, 열었던 탭과 설정 기억, 저장소가 바뀌면 자동 새로 고침
- 한국어 / English (시스템 언어를 따르거나 설정에서 선택)
- 설정: 행 높이, 날짜 형식, git 경로, 외부 편집기, 업데이트 확인
- 이슈 보고: 앱 버전·OS·git 버전·마지막 오류를 미리 채운 GitHub 이슈 페이지 열기

## 단축키
| 동작 | 단축키 |
|---|---|
| 저장소 열기 / 탭 닫기 | ⌘T / ⌘W |
| 탭 이동 | ⌘1–9, Ctrl+Tab |
| 새로 고침 | ⌘R |
| 파일 히스토리 (파일 검색) | ⌘⇧H |
| 설정 | ⌘, |
| 커밋 / 커밋하고 push | ⌘↩ / ⌥⌘↩ |
| (변경 사항) stage·unstage / diff / 편집기에서 열기 | Space / ⌘D / F4 |
| 노선 강조 해제 | Esc |
| (diff 창) 다음 / 이전 변경 | F7 / ⇧F7 (또는 ⌘↓ / ⌘↑) |
| (diff 창) 이전 / 다음 파일 | ⌘← / ⌘→ |
| (diff 창) 닫기 | Esc 또는 ⌘W |

## 개인정보
- 텔레메트리나 사용 통계를 수집하지 않습니다.
- 자동으로 나가는 네트워크 요청은 GitHub에서 새 버전을 확인하는 것 하나뿐이며, 설정에서 끌 수 있습니다.
  git의 fetch / pull / push는 사용자가 실행했거나 백그라운드 페치를 켰을 때만 일어납니다.
- 이슈 보고는 브라우저에서 미리 채운 양식을 열 뿐이고, 내용을 확인한 뒤 직접 제출합니다. 경로의 사용자 이름은 `~`로 가립니다.

## 개발
```bash
pnpm install
pnpm tauri dev        # 앱 실행
pnpm test             # TS 단위 테스트 (그래프 엔진, UI 로직, patch 생성, Rust↔TS 계약)
cd src-tauri && cargo test   # 파서, git 쓰기 작업 통합 테스트, 메뉴 막대 모델
```
Node 20 이상, pnpm, Rust(stable), Xcode 커맨드라인 도구가 필요합니다.
설계와 작업 분담은 [docs/PLAN-v0.1.md](docs/PLAN-v0.1.md)에 있습니다.

## 빌드
```bash
pnpm tauri build                                  # 현재 아키텍처용 Lanes.app / .dmg
pnpm tauri build --target universal-apple-darwin  # Apple Silicon + Intel 유니버설 빌드
```
결과물은 `src-tauri/target/<target>/release/bundle/` 아래에 생깁니다.
유니버설 빌드에는 `rustup target add aarch64-apple-darwin x86_64-apple-darwin`이 필요합니다.

### 서명, 공증, 업데이트 (배포용)
- `tauri.conf.json`의 `bundle.macOS.signingIdentity`에 Developer ID 인증서를 지정하면 빌드할 때 서명됩니다.
  직접 빌드만 해서 쓸 거라면 `signingIdentity`를 지우거나 `"-"`(ad-hoc)로 바꾸면 됩니다.
- 자동 업데이트 파일(`.app.tar.gz` + `.sig`)은 업데이트 서명 키로 서명합니다.
  키는 저장소에 넣지 않고, 빌드할 때 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 환경 변수로 넘깁니다.
  공개 키는 `tauri.conf.json`의 `plugins.updater.pubkey`에 넣습니다.
- 공증과 스테이플:
  ```bash
  xcrun notarytool submit Lanes_<ver>_universal.dmg --keychain-profile <프로필> --wait
  xcrun stapler staple Lanes_<ver>_universal.dmg
  spctl -a -vv -t install Lanes_<ver>_universal.dmg   # Gatekeeper 확인
  ```
- Homebrew cask 틀은 [packaging/homebrew/lanes.rb](packaging/homebrew/lanes.rb)에 있습니다.

## 프로젝트 구조
| 경로 | 내용 |
|---|---|
| `src/graph/` | IntelliJ 그래프 엔진 TS 포트 (레인 배치, Bek 정렬, 브랜치 노선 색과 식별) |
| `src/ui/` | 메인 창 React UI (브랜치 트리, 로그 표, 필터, 커밋 상세, 변경 사항, 작업 창, 설정) |
| `src/diffwindow/` | 좌우 비교 diff 창과 줄 단위 스테이징 |
| `src/historywindow/` | 파일 히스토리 / blame / 선택한 줄 히스토리 창 |
| `src/quickcommit/` | 메뉴 막대 빠른 커밋 창 |
| `src/i18n/` | 한국어 / 영어 문구 |
| `src/types.ts` | Rust ↔ TS 공유 계약 (명령, 이벤트, 그래프 타입) |
| `src-tauri/` | Rust 백엔드 (git 실행, 쓰기 작업, 저장소 감시, 설정, 업데이트, 메뉴 막대) |
| `design/` | 앱 아이콘과 메뉴 막대 아이콘 원본 |
| `packaging/` | Homebrew cask |

## 라이선스
[Apache License 2.0](LICENSE)을 따릅니다. Copyright 2026 J-Lab.

## 크레딧
커밋 그래프 엔진은 IntelliJ Platform VCS 로그의 일부를 TypeScript로 옮긴 것입니다(Apache License 2.0).
자세한 내용은 [NOTICE](NOTICE)를 참고하세요.

## 상표
JetBrains, IntelliJ, WebStorm은 JetBrains s.r.o.의 상표입니다. Lanes는 JetBrains와 관련이 없는 독립 프로젝트이며,
JetBrains의 후원이나 보증을 받지 않았습니다. 상표명은 출처와 호환성을 설명하는 데만 사용합니다.

번들 폰트 IBM Plex Sans KR, Archivo, JetBrains Mono는 SIL Open Font License 1.1을 따릅니다
([src/assets/fonts/LICENSES.txt](src/assets/fonts/LICENSES.txt)).
