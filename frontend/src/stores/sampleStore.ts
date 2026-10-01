import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { buildExpiryList, dueSamples, todayStr } from '../utils/degree';
import type {
  ObserveLog,
  RetainSample,
  SampleExpiry,
  SampleReviewAction,
  SampleReviewLog,
} from '../types/retain-sample';

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

/** 质检员对「待复核」留样的处置入参（必须说明理由） */
export interface ReviewResolveInput {
  /** 处置方式：沿用原留样继续观察 / 重新取样（旧留样作废） */
  action: SampleReviewAction;
  /** 质检员说明的理由（必填） */
  reason: string;
  /** 复核人 */
  qcBy: string;
  /** 重新取样时的新留样登记信息 */
  newSample?: SampleInput;
}

export interface ReviewResolveResult {
  /** 处置后的旧留样（沿用时回到观察中，重新取样时已作废） */
  sample: RetainSample;
  /** 重新取样时创建的新留样（已绑定当前判定版本） */
  newSample?: RetainSample;
}

interface SampleState {
  samples: RetainSample[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  createSample: (input: SampleInput) => Promise<RetainSample>;
  updateSample: (id: string, patch: Partial<SampleInput>) => Promise<void>;
  removeSample: (id: string) => Promise<void>;
  /** 观察记录按日期追加；待复核/已作废留样禁止追加 */
  appendObserveLog: (sampleId: string, input: ObserveInput) => Promise<void>;
  /**
   * 待复核留样处置：质检员说明理由后沿用或重新取样。
   * 旧留样状态翻转、复核留痕与新留样创建在同一事务内完成，写入失败整体回滚。
   */
  resolveReview: (sampleId: string, input: ReviewResolveInput) => Promise<ReviewResolveResult>;
  /** 由批次改判事务回写后的留样同步到内存（仅整事务成功后调用） */
  resync: (changed: RetainSample[]) => void;
  /** 到期派生清单（按剩余天数升序） */
  expiryList: (warnDays?: number) => SampleExpiry[];
  /** 到期前 30 天提醒清单 */
  dueList: (warnDays?: number) => SampleExpiry[];
  usedCabinets: () => string[];
  /** 待复核留样（改判程度转为太过） */
  pendingReview: () => RetainSample[];
}

export const useSampleStore = create<SampleState>()((set, get) => ({
  samples: [],
  hydrated: false,

  hydrate: async () => {
    const samples = await db.samples.toArray();
    set({ samples, hydrated: true });
  },

  createSample: async (input) => {
    // 留样必须绑定本次判定所依据的版本：只允许为已锁定（已有判定版本）的批次建样
    const batch = await db.batches.get(input.batchId);
    if (!batch) {
      throw new Error('关联批次不存在');
    }
    if (!batch.locked || !batch.currentVersion) {
      throw new Error('该批尚未锁定判定，请先在工序记录台锁定后再登记留样');
    }

    const sample: RetainSample = {
      id: uid('sample'),
      sampleNo: input.sampleNo.trim(),
      batchId: input.batchId,
      amountG: Number(input.amountG) || 0,
      retainMonths: Number(input.retainMonths) || 6,
      cabinet: input.cabinet,
      retainedAt: input.retainedAt ?? new Date().toISOString(),
      observeLogs: [],
      basisVersion: batch.currentVersion,
      basisDegree: batch.degree,
      reviewState: '观察中',
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
    const current = get().samples.find((s) => s.id === id);
    if (current?.reviewState === '待复核') {
      throw new Error('待复核留样须先完成复核处置，不能直接删除');
    }
    await db.samples.delete(id);
    set({ samples: get().samples.filter((s) => s.id !== id) });
  },

  appendObserveLog: async (sampleId, input) => {
    const current = get().samples.find((s) => s.id === sampleId);
    if (!current) {
      return;
    }
    if (current.reviewState === '待复核') {
      throw new Error('该留样待质检复核：说明理由并沿用后方可继续观察');
    }
    if (current.reviewState === '已作废') {
      throw new Error('该留样已被重新取样替代（作废），不再追加观察');
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

  resolveReview: async (sampleId, input) => {
    const reason = input.reason.trim();
    if (!reason) {
      throw new Error('请填写质检复核理由');
    }
    const qcBy = input.qcBy.trim();
    if (!qcBy) {
      throw new Error('请填写复核人');
    }

    // 旧留样状态、复核留痕与新留样创建在同一事务内完成：写入失败时两者均不变
    return db.transaction('rw', db.samples, db.batches, async () => {
      const oldSample = await db.samples.get(sampleId);
      if (!oldSample) {
        throw new Error('留样不存在');
      }
      if (oldSample.reviewState !== '待复核') {
        throw new Error('仅待复核留样可进行复核处置');
      }

      const nowIso = new Date().toISOString();
      const reviewLog: SampleReviewLog = {
        id: uid('review'),
        action: input.action,
        reason,
        qcBy,
        reviewedAt: nowIso,
      };

      let created: RetainSample | undefined;

      if (input.action === '重新取样') {
        const payload = input.newSample;
        if (!payload) {
          throw new Error('请完整填写新留样信息');
        }
        const batch = await db.batches.get(oldSample.batchId);
        if (!batch?.currentVersion) {
          throw new Error('关联批次缺少生效判定版本，无法绑定新留样');
        }
        // 新留样绑定本次判定所依据的版本
        created = {
          id: uid('sample'),
          sampleNo: payload.sampleNo.trim(),
          batchId: oldSample.batchId,
          amountG: Number(payload.amountG) || 0,
          retainMonths: Number(payload.retainMonths) || 6,
          cabinet: payload.cabinet,
          retainedAt: payload.retainedAt ?? nowIso,
          observeLogs: [],
          basisVersion: batch.currentVersion,
          basisDegree: batch.degree,
          reviewState: '观察中',
        };
        reviewLog.newSampleNo = created.sampleNo;
        reviewLog.newSampleId = created.id;

        const resolved: RetainSample = {
          ...oldSample,
          reviewState: '已作废',
          pendingReason: undefined,
          reviewLogs: [...(oldSample.reviewLogs ?? []), reviewLog],
        };
        await db.samples.bulkPut([resolved, created]);
        set({
          samples: [...get().samples.map((s) => (s.id === sampleId ? resolved : s)), created],
        });
        return { sample: resolved, newSample: created };
      }

      // 沿用原留样：回到观察中，继续按原留样台账观察
      const resolved: RetainSample = {
        ...oldSample,
        reviewState: '观察中',
        pendingReason: undefined,
        reviewLogs: [...(oldSample.reviewLogs ?? []), reviewLog],
      };
      await db.samples.put(resolved);
      set({ samples: get().samples.map((s) => (s.id === sampleId ? resolved : s)) });
      return { sample: resolved };
    });
  },

  resync: (changed) => {
    if (changed.length === 0) return;
    const byId = new Map(changed.map((s) => [s.id, s]));
    set({ samples: get().samples.map((s) => byId.get(s.id) ?? s) });
  },

  expiryList: (warnDays = 30) => buildExpiryList(get().samples, warnDays),

  dueList: (warnDays = 30) => dueSamples(get().samples, warnDays),

  usedCabinets: () => Array.from(new Set(get().samples.map((s) => s.cabinet))),

  pendingReview: () => get().samples.filter((s) => s.reviewState === '待复核'),
}));
