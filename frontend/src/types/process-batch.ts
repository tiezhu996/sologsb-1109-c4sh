import type { FireLevel } from './processing-method';

/** 炮制程度 */
export type ProcessDegree = '不及' | '适中' | '太过';

/** 判定版本类型 */
export type BatchReviewKind = '初判' | '复核改判';

/**
 * 一次程度判定的复核版本（只增不改）。
 * 初判锁定时生成 v1；质检员改判追加新版本，旧版本完整保留，
 * 留样绑定其所依据的版本 id，事后仍可对照前后差异。
 */
export interface BatchReview {
  id: string;
  /** 版本序号，从 1 开始 */
  version: number;
  kind: BatchReviewKind;
  /** 判定时间 ISO */
  judgedAt: string;
  /** 判定/改判人 */
  judgeBy: string;
  /** 该版本的炮制程度 */
  degree: ProcessDegree;
  /** 该版本的得率（%） */
  yieldRate: number;
  /** 该版本采用的炮制方法 */
  methodId: string;
  /** 该版本的火候 */
  fireLevel: FireLevel;
  /** 初判依据或本次改判原因 */
  reason: string;
}

/** 炮制工序记录 */
export interface ProcessBatch {
  id: string;
  /** 生产批号 */
  batchNo: string;
  /** 关联药材 */
  herbId: string;
  /** 采用方法 */
  methodId: string;
  /** 投料量（kg） */
  feedKg: number;
  /** 辅料实际用量（kg） */
  auxUsedKg: number;
  /** 火候 */
  fireLevel: FireLevel;
  /** 开始时间 ISO */
  startedAt: string;
  /** 结束时间 ISO */
  endedAt: string;
  /** 得率（%），始终为最新判定版本的值 */
  yieldRate: number;
  /** 程度判定，始终为最新判定版本的值 */
  degree: ProcessDegree;
  /** 操作人 */
  operator: string;
  /** 得率与程度提交后锁定，仅质检员可改 */
  locked: boolean;
  /** 锁定时间 */
  lockedAt?: string;
  /** 质检员放行/改判人 */
  qcBy?: string;
  /** 备注 */
  remark?: string;
  /** 判定版本链（v1 为初判，其后为复核改判），只增不改 */
  reviews: BatchReview[];
}

/** 程度判定规则说明 */
export interface DegreeRule {
  degree: ProcessDegree;
  condition: string;
  action: string;
}

export const PROCESS_DEGREES: ProcessDegree[] = ['不及', '适中', '太过'];
