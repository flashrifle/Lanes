// Ours / theirs labels that follow the operation: during a rebase git's "ours" is the upstream (onto) side
// and "theirs" is your commit being replayed.
import type { ConflictSide, OperationState } from '../../types';
import { t } from '../../i18n';

export function conflictSideLabel(side: ConflictSide, op: OperationState | null, short = false): string {
  const rebase = op?.operation === 'rebase';
  if (rebase) return side === 'ours' ? t(short ? 'conflict.upstreamShort' : 'conflict.acceptUpstream') : t(short ? 'conflict.yoursShort' : 'conflict.acceptYoursRebase');
  return side === 'ours' ? t(short ? 'conflict.yoursShort' : 'conflict.acceptYours') : t(short ? 'conflict.theirsShort' : 'conflict.acceptTheirs');
}
