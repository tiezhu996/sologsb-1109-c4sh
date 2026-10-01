import type { ProcessDegree } from './process-batch';

/** 单次留样观察记录 */
export interface ObserveLog {
  id: string;
  /** 观察日期 YYYY-MM-DD */
  date: string;
  /** 色泽 */
  color: string;
  /** 气味 */
  odor: string;
  /** 霉变情况 */
  mold: string;
  /** 观察人 */
  observer: string;
  /** 备注 */
  note?: string;
}

/** 留样复核状态：观察中 ⇄ 待复核；重新取样后旧留样作废 */
export type SampleReviewState = '观察中' | '待复核' | '已作废';

/** 留样复核处置方式 */
export type SampleReviewAction = '沿用' | '重新取样';

/** 留样复核处理留痕（质检员说明理由后的处置记录） */
export interface SampleReviewLog {
  id: string;
  /** 处置方式 */
  action: SampleReviewAction;
  /** 质检员说明的理由 */
  reason: string;
  /** 复核人 */
  qcBy: string;
  /** 复核时间 ISO */
  reviewedAt: string;
  /** 处置为重新取样时，新留样编号 */
  newSampleNo?: string;
  /** 处置为重新取样时，新留样 id */
  newSampleId?: string;
}

/** 留样 */
export interface RetainSample {
  id: string;
  /** 留样编号 */
  sampleNo: string;
  /** 关联炮制批次 */
  batchId: string;
  /** 留样量（g） */
  amountG: number;
  /** 留样期（月） */
  retainMonths: number;
  /** 柜位 */
  cabinet: string;
  /** 留样日期 ISO */
  retainedAt: string;
  /** 观察记录，按日期追加 */
  observeLogs: ObserveLog[];
  /** 本留样判定所依据的批次判定版本号（锁定批次建样时绑定） */
  basisVersion?: number;
  /** 该版本当时的程度判定快照，改判后仍可看出留样基于哪一版结论 */
  basisDegree?: ProcessDegree;
  /** 复核状态：观察中 / 待复核（程度转为太过）/ 已作废（被新取样替代） */
  reviewState?: SampleReviewState;
  /** 待复核原因（批次改判为太过时写入） */
  pendingReason?: string;
  /** 复核处置留痕 */
  reviewLogs?: SampleReviewLog[];
}

/** 留样柜位（A/B/C 三柜，每柜 12 位） */
export const CABINETS: string[] = ['A', 'B', 'C'].flatMap((c) =>
  Array.from({ length: 12 }, (_, i) => `${c}-${String(i + 1).padStart(2, '0')}`),
);

/** 留样到期派生态 */
export type SampleExpiryState = '已到期' | '临期' | '观察中';

/** 留样到期派生信息 */
export interface SampleExpiry {
  sample: RetainSample;
  /** 到期日 YYYY-MM-DD */
  expireAt: string;
  /** 距到期剩余天数（负数表示已过期） */
  daysLeft: number;
  state: SampleExpiryState;
}
