import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { latestReview } from '../utils/review';
import { useSampleStore } from './sampleStore';
import type { FireLevel } from '../types/processing-method';
import type { BatchReview, ProcessBatch, ProcessDegree } from '../types/process-batch';
import type { RetainSample } from '../types/retain-sample';

export interface BatchInput {
  batchNo: string;
  herbId: string;
  methodId: string;
  feedKg: number;
  auxUsedKg: number;
  fireLevel: FireLevel;
  startedAt: string;
  endedAt: string;
  yieldRate: number;
  degree: ProcessDegree;
  operator: string;
  remark?: string;
}

/** 质检员复核改判入参：只允许调整判定结论相关字段，且必须说明原因 */
export interface ReviewInput {
  degree: ProcessDegree;
  yieldRate: number;
  methodId: string;
  fireLevel: FireLevel;
  /** 改判原因（质检员必填） */
  reason: string;
  /** 改判人 */
  qcBy: string;
}

interface BatchState {
  batches: ProcessBatch[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  createBatch: (input: BatchInput, lock?: boolean) => Promise<ProcessBatch>;
  updateBatch: (id: string, patch: Partial<BatchInput>, force?: boolean) => Promise<boolean>;
  removeBatch: (id: string) => Promise<void>;
  /** 提交得率与程度判定后锁定该批 */
  lockBatch: (id: string) => Promise<void>;
  /** 质检员放行：解锁以便重新编辑（不改判定结论） */
  unlockAsQc: (id: string, qcBy: string) => Promise<void>;
  /**
   * 质检员复核改判：追加一个判定版本（保留前后程度、得率、方法与原因），
   * 批次保持锁定；程度转为「太过」时，关联的观察中留样一并置为待复核。
   * 批次写入与留样状态变更在同一事务内，任一写入失败则整体回滚。
   */
  reviewAsQc: (id: string, input: ReviewInput) => Promise<{ batch: ProcessBatch; pendingSamples: number }>;
  degreeCount: () => Record<ProcessDegree, number>;
  pendingBatches: () => ProcessBatch[];
  batchesOfHerb: (herbId: string) => ProcessBatch[];
}

/** 以批次当前结论生成初判版本 */
function buildInitialReview(batch: ProcessBatch, judgeBy?: string): BatchReview {
  return {
    id: uid('review'),
    version: 1,
    kind: '初判',
    judgedAt: batch.lockedAt ?? batch.endedAt,
    judgeBy: judgeBy ?? batch.qcBy ?? batch.operator,
    degree: batch.degree,
    yieldRate: batch.yieldRate,
    methodId: batch.methodId,
    fireLevel: batch.fireLevel,
    reason: batch.remark ? `初判：${batch.remark}` : '初判提交后锁定',
  };
}

export const useBatchStore = create<BatchState>()((set, get) => ({
  batches: [],
  hydrated: false,

  hydrate: async () => {
    const batches = await db.batches.orderBy('startedAt').reverse().toArray();
    set({ batches, hydrated: true });
  },

  createBatch: async (input, lock = false) => {
    const now = new Date().toISOString();
    const batch: ProcessBatch = {
      id: uid('batch'),
      batchNo: input.batchNo.trim(),
      herbId: input.herbId,
      methodId: input.methodId,
      feedKg: Number(input.feedKg) || 0,
      auxUsedKg: Number(input.auxUsedKg) || 0,
      fireLevel: input.fireLevel,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      yieldRate: Number(input.yieldRate) || 0,
      degree: input.degree,
      operator: input.operator.trim(),
      locked: lock,
      lockedAt: lock ? now : undefined,
      remark: input.remark?.trim() || undefined,
      reviews: [],
    };
    if (lock) {
      batch.reviews = [buildInitialReview(batch)];
    }
    await db.batches.put(batch);
    set({ batches: [batch, ...get().batches] });
    return batch;
  },

  updateBatch: async (id, patch, force = false) => {
    const current = get().batches.find((b) => b.id === id);
    if (!current) {
      return false;
    }
    if (current.locked && !force) {
      return false;
    }
    const next: ProcessBatch = { ...current, ...patch };
    if (force) {
      next.qcBy = next.qcBy ?? '质检员 · 赵敏';
    }
    await db.batches.put(next);
    set({ batches: get().batches.map((b) => (b.id === id ? next : b)) });
    return true;
  },

  removeBatch: async (id) => {
    await db.batches.delete(id);
    set({ batches: get().batches.filter((b) => b.id !== id) });
  },

  lockBatch: async (id) => {
    const current = get().batches.find((b) => b.id === id);
    if (!current) {
      return;
    }
    const next: ProcessBatch = { ...current, locked: true, lockedAt: current.lockedAt ?? new Date().toISOString() };
    // 兼容旧数据/未锁定即建版的批次：锁定时补录初判版本
    if (next.reviews.length === 0) {
      next.reviews = [buildInitialReview(next)];
    }
    await db.batches.put(next);
    set({ batches: get().batches.map((b) => (b.id === id ? next : b)) });
  },

  unlockAsQc: async (id, qcBy) => {
    const current = get().batches.find((b) => b.id === id);
    if (!current) {
      return;
    }
    const next: ProcessBatch = { ...current, locked: false, qcBy };
    await db.batches.put(next);
    set({ batches: get().batches.map((b) => (b.id === id ? next : b)) });
  },

  reviewAsQc: async (id, input) => {
    const current = get().batches.find((b) => b.id === id);
    if (!current) {
      throw new Error('未找到该炮制批次');
    }
    if (!current.locked) {
      throw new Error('仅已锁定批次可由质检员复核改判');
    }
    if (current.reviews.length === 0) {
      throw new Error('该批缺少初判版本，无法复核');
    }
    const previous = latestReview(current)!;
    const reason = input.reason.trim();
    if (!reason) {
      throw new Error('请填写本次改判原因');
    }
    if (
      previous.degree === input.degree &&
      previous.yieldRate === Number(input.yieldRate) &&
      previous.methodId === input.methodId &&
      previous.fireLevel === input.fireLevel
    ) {
      throw new Error('程度、得率、方法与火候与上一版完全一致，无需新增复核版本');
    }

    const review: BatchReview = {
      id: uid('review'),
      version: previous.version + 1,
      kind: '复核改判',
      judgedAt: new Date().toISOString(),
      judgeBy: input.qcBy,
      degree: input.degree,
      yieldRate: Number(input.yieldRate) || 0,
      methodId: input.methodId,
      fireLevel: input.fireLevel,
      reason,
    };
    const next: ProcessBatch = {
      ...current,
      degree: review.degree,
      yieldRate: review.yieldRate,
      methodId: review.methodId,
      fireLevel: review.fireLevel,
      qcBy: input.qcBy,
      reviews: [...current.reviews, review],
    };

    // 程度转为太过：关联留样先待复核（已是待复核/沿用的不动），记录原因
    const turnedOver = previous.degree !== '太过' && review.degree === '太过';
    let pendingSamples = 0;
    let updatedSamples: RetainSample[] = [];

    // 批次与留样同一事务写入：失败整体回滚，不会出现批次已改而留样半改
    await db.transaction('rw', db.batches, db.samples, async () => {
      await db.batches.put(next);
      if (turnedOver) {
        const linked = await db.samples.where('batchId').equals(id).toArray();
        updatedSamples = linked.map((sample) => {
          if (sample.reviewState === 'pending' || sample.reviewState === 'keep') {
            return sample;
          }
          pendingSamples += 1;
          return {
            ...sample,
            reviewState: 'pending',
            pendingReason: `v${review.version} 复核改判为「太过」：${reason}`,
          };
        });
        if (updatedSamples.length > 0) {
          await db.samples.bulkPut(updatedSamples);
        }
      }
    });

    set({ batches: get().batches.map((b) => (b.id === id ? next : b)) });
    if (updatedSamples.length > 0) {
      const byId = new Map(updatedSamples.map((s) => [s.id, s]));
      useSampleStore.setState((state) => ({
        samples: state.samples.map((s) => byId.get(s.id) ?? s),
      }));
    }
    return { batch: next, pendingSamples };
  },

  degreeCount: () => {
    const result: Record<ProcessDegree, number> = { 不及: 0, 适中: 0, 太过: 0 };
    get().batches.forEach((b) => {
      result[b.degree] += 1;
    });
    return result;
  },

  pendingBatches: () => get().batches.filter((b) => !b.locked),

  batchesOfHerb: (herbId) => get().batches.filter((b) => b.herbId === herbId),
}));
