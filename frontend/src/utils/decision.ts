import type { BatchDecision, ProcessBatch } from '../types/process-batch';

/** 取批次当前生效的判定版本（流水末版） */
export function currentDecision(batch: ProcessBatch): BatchDecision | undefined {
  return batch.decisions?.[batch.decisions.length - 1];
}

/** 按版本号取历史判定 */
export function decisionAt(batch: ProcessBatch, version?: number): BatchDecision | undefined {
  if (!batch.decisions || version === undefined) return undefined;
  return batch.decisions.find((d) => d.version === version);
}

/** 留样依据版本相对当前版本是否已被改判 */
export function isBasisStale(batch: ProcessBatch, basisVersion?: number): boolean {
  if (basisVersion === undefined || !batch.currentVersion) return false;
  return basisVersion < batch.currentVersion;
}

/** 取留样所依据的判定版本 */
export function basisDecision(batch: ProcessBatch, basisVersion?: number): BatchDecision | undefined {
  return decisionAt(batch, basisVersion);
}
