import type { FireLevel } from './processing-method';

/** 炮制程度 */
export type ProcessDegree = '不及' | '适中' | '太过';

/** 判定版本类型：首次锁定为初判，质检员改判/放行重锁为改判 */
export type DecisionKind = '初判' | '改判';

/**
 * 程度判定复核版本（不可变快照）。
 * 改判不覆盖旧结论，而是追加新版本；留样绑定其当时判定所依据的版本。
 */
export interface BatchDecision {
  /** 版本序号，从 1 起逐版递增 */
  version: number;
  /** 初判 / 改判 */
  kind: DecisionKind;
  /** 该版程度判定 */
  degree: ProcessDegree;
  /** 该版得率（%） */
  yieldRate: number;
  /** 该版采用的炮制方法 */
  methodId: string;
  /** 该版火候 */
  fireLevel: FireLevel;
  /** 该版实际锅温（℃） */
  temp?: number;
  /** 该版炮制时长（min） */
  duration?: number;
  /** 判定/改判理由（改判时必填，留痕备查） */
  reason: string;
  /** 判定人（初判为提交人，改判为质检员） */
  qcBy: string;
  /** 判定时间 ISO */
  decidedAt: string;
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
  /** 实际锅温（℃） */
  temp?: number;
  /** 炮制时长（min） */
  duration?: number;
  /** 开始时间 ISO */
  startedAt: string;
  /** 结束时间 ISO */
  endedAt: string;
  /** 得率（%），始终为当前生效版本的值 */
  yieldRate: number;
  /** 程度判定，始终为当前生效版本的值 */
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
  /** 当前生效判定版本号；未锁定（尚未初判）时为空 */
  currentVersion?: number;
  /** 判定版本流水，初判为 v1，每次质检改判追加一版，旧结论保留 */
  decisions?: BatchDecision[];
}

/** 程度判定规则说明 */
export interface DegreeRule {
  degree: ProcessDegree;
  condition: string;
  action: string;
}

export const PROCESS_DEGREES: ProcessDegree[] = ['不及', '适中', '太过'];
