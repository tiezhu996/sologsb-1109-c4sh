import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { buildExpiryList, dueSamples, todayStr } from '../utils/degree';
import { latestReview } from '../utils/review';
import type { ObserveLog, RetainSample, SampleExpiry, SampleReviewNote, SampleReviewState } from '../types/retain-sample';
import type { ProcessBatch } from '../types/process-batch';

export interface SampleInput {
  sampleNo: string;
  batchId: string;
  amountG: number;
  retainMonths: number;
  cabinet: string;
  retainedAt?: string;
}

export interface ObserveInput {
  date: string;
  color: string;
  odor: string;
  mold: string;
  observer: string;
  note?: string;
}

/** 待复核处置入参 */
export interface ResolveReviewInput {
  /** 处置质检员 */
  by: string;
  /** 说明理由（必填） */
  reason: string;
  action: '沿用' | '重新取样';
  /** action=重新取样 时，新留样的登记信息 */
  newSample?: Omit<SampleInput, 'batchId'>;
}

interface SampleState {
  samples: RetainSample[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  createSample: (input: SampleInput) => Promise<RetainSample>;
  updateSample: (id: string, patch: Partial<SampleInput>) => Promise<void>;
  removeSample: (id: string) => Promise<void>;
  /** 观察记录按日期追加 */
  appendObserveLog: (sampleId: string, input: ObserveInput) => Promise<void>;
  /**
   * 处置「待复核」留样：质检员说明理由后沿用原留样（继续按原版本观察），
   * 或登记新留样（绑定本次判定版本，旧留样留存备查）。
   * 旧留样状态与新留样登记在同一事务内，失败整体回滚。
   */
  resolveSampleReview: (sampleId: string, input: ResolveReviewInput) => Promise<RetainSample | undefined>;
  /** 到期派生清单（按剩余天数升序） */
  expiryList: (warnDays?: number) => SampleExpiry[];
  /** 到期前 30 天提醒清单 */
  dueList: (warnDays?: number) => SampleExpiry[];
  usedCabinets: () => string[];
}

export const useSampleStore = create<SampleState>()((set, get) => ({
  samples: [],
  hydrated: false,

  hydrate: async () => {
    const samples = await db.samples.toArray();
    set({ samples, hydrated: true });
  },

  createSample: async (input) => {
    // 留样绑定登记时批次的最新判定版本（即本次留样所依据的版本）
    const batch = await db.batches.get(input.batchId);
    const review = batch ? latestReview(batch) : undefined;
    const sample: RetainSample = {
      id: uid('sample'),
      sampleNo: input.sampleNo.trim(),
      batchId: input.batchId,
      amountG: Number(input.amountG) || 0,
      retainMonths: Number(input.retainMonths) || 6,
      cabinet: input.cabinet,
      retainedAt: input.retainedAt ?? new Date().toISOString(),
      observeLogs: [],
      reviewId: review?.id,
      reviewState: 'observing',
    };
    await db.samples.put(sample);
    set({ samples: [...get().samples, sample] });
    return sample;
  },

  updateSample: async (id, patch) => {
    const current = get().samples.find((s) => s.id === id);
    if (!current) {
      return;
    }
    const next: RetainSample = { ...current, ...patch };
    await db.samples.put(next);
    set({ samples: get().samples.map((s) => (s.id === id ? next : s)) });
  },

  removeSample: async (id) => {
    await db.samples.delete(id);
    set({ samples: get().samples.filter((s) => s.id !== id) });
  },

  appendObserveLog: async (sampleId, input) => {
    const current = get().samples.find((s) => s.id === sampleId);
    if (!current) {
      return;
    }
    const log: ObserveLog = {
      id: uid('log'),
      date: input.date || todayStr(),
      color: input.color,
      odor: input.odor,
      mold: input.mold,
      observer: input.observer,
      note: input.note?.trim() || undefined,
    };
    const logs = [...current.observeLogs, log].sort((a, b) => a.date.localeCompare(b.date));
    const next: RetainSample = { ...current, observeLogs: logs };
    await db.samples.put(next);
    set({ samples: get().samples.map((s) => (s.id === sampleId ? next : s)) });
  },

  resolveSampleReview: async (sampleId, input) => {
    const current = get().samples.find((s) => s.id === sampleId);
    if (!current) {
      return undefined;
    }
    if (current.reviewState !== 'pending') {
      throw new Error('仅「待复核」留样需要处置');
    }
    const reason = input.reason.trim();
    if (!reason) {
      throw new Error('请质检员说明处置理由');
    }

    const note: SampleReviewNote = {
      at: new Date().toISOString(),
      by: input.by.trim(),
      reason,
      action: input.action,
    };
    const resolved: RetainSample = {
      ...current,
      reviewState: input.action === '沿用' ? 'keep' : 'resampled',
      reviewNote: note,
      // 沿用：保留 pendingReason 留痕；重新取样：同样留存待查
    };

    let created: RetainSample | undefined;
    if (input.action === '重新取样') {
      if (!input.newSample) {
        throw new Error('重新取样需填写新留样信息');
      }
      const batch: ProcessBatch | undefined = await db.batches.get(current.batchId);
      const review = batch ? latestReview(batch) : undefined;
      created = {
        id: uid('sample'),
        sampleNo: input.newSample.sampleNo.trim(),
        batchId: current.batchId,
        amountG: Number(input.newSample.amountG) || 0,
        retainMonths: Number(input.newSample.retainMonths) || 6,
        cabinet: input.newSample.cabinet,
        retainedAt: input.newSample.retainedAt ?? new Date().toISOString(),
        observeLogs: [],
        reviewId: review?.id,
        reviewState: 'observing',
      };
    }

    // 旧留样处置与新留样登记同一事务：失败整体回滚，不存在半改状态
    await db.transaction('rw', db.samples, async () => {
      await db.samples.put(resolved);
      if (created) {
        await db.samples.put(created);
      }
    });

    // 注意：zustand v4 的 set 直接接受下一个 state（非函数式 updater），
    // 通过 get() 取最新内存态，避免合并阶段抛错导致已提交的事务被误判为失败
    const currentSamples = get().samples;
    set({
      samples: created
        ? [...currentSamples.map((s) => (s.id === sampleId ? resolved : s)), created]
        : currentSamples.map((s) => (s.id === sampleId ? resolved : s)),
    });
    return created;
  },

  expiryList: (warnDays = 30) => buildExpiryList(get().samples, warnDays),

  dueList: (warnDays = 30) => dueSamples(get().samples, warnDays),

  usedCabinets: () => Array.from(new Set(get().samples.map((s) => s.cabinet))),
}));

/** 待复核留样数（首页/台账角标用） */
export function countPending(samples: RetainSample[]): number {
  return samples.filter((s) => (s.reviewState ?? 'observing') === 'pending').length;
}

export type { SampleReviewState };
