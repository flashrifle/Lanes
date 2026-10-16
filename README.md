<p align="center"><img src="design/icon.png" width="128" alt="Lanes"></p>

# Lanes

JetBrains IDE의 Git 툴 윈도우를 본뜬, 빠르고 가벼운 macOS용 독립 실행형 Git 로그 뷰어입니다.
IDE를 열지 않고도 브랜치 트리, 커밋 그래프, 필터, 변경 파일, 좌우 비교 diff 창을 그대로 쓸 수 있습니다.

Tauri 2(Rust) + React + TypeScript로 만들었고, 시스템에 설치된 `git`을 그대로 사용합니다.

## 주요 기능
- **브랜치 트리**: 로컬 / 리모트 / 태그, `/` 기준 폴더 묶음, 즐겨찾기. 체크아웃, 새 브랜치, 삭제, 페치, 풀 지원
- **커밋 그래프**: IntelliJ와 같은 레인 배치와 "Standard"(Bek) 정렬. 커밋 10만 개 이상도 부드럽게 표시
- **필터**: 텍스트/해시(정규식, 대소문자 구분), 브랜치, 사용자, 날짜, 경로. 걸러진 히스토리는 점선으로 연결
- **변경 사항**: 변경 파일 트리, 커밋 상세, 단어 단위 하이라이트가 있는 별도 좌우 비교 diff 창
- **여러 저장소를 탭으로** 열기, 저장소가 바뀌면 자동 새로 고침

## 단축키
| 동작 | 단축키 |
|---|---|
| 저장소 열기 / 탭 닫기 | ⌘T / ⌘W |
| 탭 이동 | ⌘1–9, Ctrl+Tab |
| 새로 고침 | ⌘R |
| (diff 창) 다음 / 이전 변경 | F7 / ⇧F7 (또는 ⌘↓ / ⌘↑) |
| (diff 창) 이전 / 다음 파일 | ⌘← / ⌘→ |
| (diff 창) 닫기 | Esc 또는 ⌘W |

## 개발
```bash
pnpm install
pnpm tauri dev        # 앱 실행
pnpm test             # TS 단위 테스트 (그래프 엔진, UI 로직, Rust↔TS 계약)
cd src-tauri && cargo test
```
Node 20 이상, pnpm, Rust(stable), Xcode 커맨드라인 도구가 필요합니다.

## 빌드
```bash
pnpm tauri build      # src-tauri/target/release/bundle/ 아래에 Lanes.app 과 .dmg 생성
```

## 크레딧
커밋 그래프 엔진은 IntelliJ Platform VCS 로그의 일부를 TypeScript로 옮긴 것입니다(Apache License 2.0).
자세한 내용은 [NOTICE](NOTICE)를 참고하세요. Lanes는 JetBrains와 관련이 없는 독립 프로젝트입니다.
