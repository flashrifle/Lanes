// i18n part owned by ui-app (prefix: quick.*). Spread into src/i18n/ko.ts.
import type { Entry, Params } from '../ko';

const n = (v: string | number): string => Number(v).toLocaleString('ko-KR');

export const quickKo = {
  'quick.title': '빠른 커밋',
  'quick.noRepo': '저장소를 선택하세요',
  'quick.noRepoHint': '메뉴 막대 아이콘에서 저장소의 "빠른 커밋…"을 선택하세요.',
  'quick.loading': '변경 사항을 불러오는 중…',
  'quick.noChanges': '변경 사항이 없습니다',
  'quick.files': (p: Params) => `변경된 파일 ${n(p.n)}개`,
  'quick.staged': (p: Params) => `${n(p.n)}개 선택됨`,
  'quick.selectAll': '모두 선택',
  'quick.truncated': '파일이 너무 많아 일부만 표시합니다',
  'quick.conflict': '충돌',
  'quick.conflictHint': '충돌을 해결한 뒤 Lanes에서 커밋하세요',
  'quick.partial': '일부만 스테이징됨',
  'quick.messagePh': '커밋 메시지',
  'quick.commit': '커밋',
  'quick.commitPush': '커밋하고 푸시',
  'quick.committing': '커밋하는 중…',
  'quick.pushing': '푸시하는 중…',
  'quick.committed': '커밋했습니다',
  'quick.pushed': '커밋하고 푸시했습니다',
  'quick.commitFail': (p: Params) => `커밋 실패: ${p.msg}`,
  'quick.pushFail': (p: Params) => `커밋은 완료했지만 푸시하지 못했습니다: ${p.msg}`,
  'quick.noRemote': '커밋은 완료했지만 푸시할 원격 저장소가 없습니다',
  'quick.retryPush': '푸시 다시 시도',
  'quick.openLanes': 'Lanes 열기',
  'quick.statusFail': (p: Params) => `상태를 불러올 수 없습니다: ${p.msg}`,
  'quick.detached': '분리된 HEAD',
  'quick.hint': 'Esc 닫기 · ⌘↩ 커밋',
} satisfies Record<string, Entry>;
