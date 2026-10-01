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

/**
 * 留样复核状态（独立于到期状态）：
 * - observing 观察中：正常按原判定版本继续观察
 * - pending 待复核：关联批次被复核改判为「太过」，等质检员说明理由后处置
 * - keep 沿用原留样：质检员说明理由后沿用，继续按原判定版本观察
 * - resampled 已重新取样：旧留样留存备查，新留样绑定改判后的版本继续观察
 */
export type SampleReviewState = 'observing' | 'pending' | 'keep' | 'resampled';

/** 留样复核处置说明（质检员在待复核后的处理留痕） */
export interface SampleReviewNote {
  /** 处置时间 ISO */
  at: string;
  /** 处置人 */
  by: string;
  /** 质检员说明的理由 */
  reason: string;
  action: '沿用' | '重新取样';
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
  /** 本次留样所依据的判定版本 id（ProcessBatch.reviews[].id） */
  reviewId?: string;
  /** 留样复核状态，缺省视为 observing（观察中） */
  reviewState?: SampleReviewState;
  /** 关联批次改判为「太过」时记录的待复核原因 */
  pendingReason?: string;
  /** 待复核处置留痕（沿用 / 已重新取样） */
  reviewNote?: SampleReviewNote;
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
  /** 留样所依据版本的程度（由页面结合批次数据补入） */
  boundDegree?: ProcessDegree;
  /** 留样所依据版本的序号（由页面结合批次数据补入） */
  boundVersion?: number;
  /** 关联批次当前是否已有更新的判定版本 */
  stale?: boolean;
}

export const SAMPLE_REVIEW_LABEL: Record<SampleReviewState, string> = {
  observing: '观察中',
  pending: '待复核',
  keep: '沿用原留样',
  resampled: '已重新取样',
};
