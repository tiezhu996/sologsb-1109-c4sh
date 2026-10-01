import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { currentDecision } from '../utils/decision';
import type { FireLevel } from '../types/processing-method';
import type { BatchDecision, ProcessBatch, ProcessDegree } from '../types/process-batch';
import type { RetainSample } from '../types/retain-sample';
import { useSampleStore } from './sampleStore';

export interface BatchInput {
  batchNo: string;
  herbId: string;
  methodId: string;
  feedKg: number;
  auxUsedKg: number;
  fireLevel: FireLevel;
  /** 实际锅温（℃） */
  temp?: number;
  /** 炮制时长（min） */
  duration?: number;
  startedAt: string;
  endedAt: string;
  yieldRate: number;
  degree: ProcessDegree;
  operator: string;
  remark?: string;
}

/** 质检员改判入参：保留前后程度、得率、方法与改判原因 */
export interface RejudgeInput {
  degree: ProcessDegree;
  yieldRate: number;
  methodId: string;
  fireLevel: FireLevel;
  temp?: number;
  duration?: number;
  /** 改判原因（必填，写入新版流水） */
  reason: string;
  /** 质检员姓名 */
  qcBy: string;
}

export interface RejudgeResult {
  batch: ProcessBatch;
  /** 本次改判被置为待复核的关联留样 */
  heldSamples: RetainSample[];
}

/** 初判/改判时附带的关联留样联动结果 */
interface DecisionSideEffect {
  heldSamples: RetainSample[];
  updatedSamples: RetainSample[];
}

interface BatchState {
  batches: ProcessBatch[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  createBatch: (input: BatchInput, lock?: boolean) => Promise<ProcessBatch>;
  updateBatch: (id: string, patch: Partial<BatchInput>) => Promise<boolean>;
  removeBatch: (id: string) => Promise<void>;
  /** 提交得率与程度判定后锁定该批，首锁写入 v1 初判版本并绑定关联留样 */
  lockBatch: (id: string, qcBy?: string, reason?: string) => Promise<RejudgeResult | undefined>;
  /** 质检员复核改判：追加判定版本，旧版本保留；程度转为太过时关联留样置为待复核。整事务原子完成 */
  rejudgeBatch: (id: string, input: RejudgeInput) => Promise<RejudgeResult | undefined>;
  /** 质检员放行：解锁后可重新编辑，再次锁定即为改判版本 */
  unlockAsQc: (id: string, qcBy: string) => Promise<void>;
  degreeCount: () => Record<ProcessDegree, number>;
  pendingBatches: () => ProcessBatch[];
  batchesOfHerb: (herbId: string) => ProcessBatch[];
}

/** 程度转为太过时，将关联留样置为待复核（已作废的不动） */
function collectHeld(samples: RetainSample[], batchId: string, fromVersion: number, reason: string): RetainSample[] {
  const held: RetainSample[] = [];
  for (const sample of samples) {
    if (sample.batchId !== batchId) continue;
    if (sample.reviewState === '已作废') continue;
    // 依据版本不晚于本次改判前的有效版本，才属于受旧结论影响的关联留样
    const basis = sample.basisVersion ?? fromVersion;
    if (basis > fromVersion) continue;
    if (sample.reviewState === '待复核') {
      held.push(sample);
      continue;
    }
    sample.reviewState = '待复核';
    sample.pendingReason = reason;
    held.push(sample);
  }
  return held;
}

export const useBatchStore = create<BatchState>()((set, get) => ({
  batches: [],
  hydrated: false,

  hydrate: async () => {
    const batches = await db.batches.orderBy('startedAt').reverse().toArray();
    set({ batches, hydrated: true });
  },

  createBatch: async (input, lock = false) => {
    const nowIso = new Date().toISOString();
    const decisions: BatchDecision[] | undefined = lock
      ? [
          {
            version: 1,
            kind: '初判',
            degree: input.degree,
            yieldRate: Number(input.yieldRate) || 0,
            methodId: input.methodId,
            fireLevel: input.fireLevel,
            temp: input.temp,
            duration: input.duration,
            reason: '提交即锁定：班组初判',
            qcBy: input.operator.trim(),
            decidedAt: nowIso,
          },
        ]
      : undefined;
    const batch: ProcessBatch = {
      id: uid('batch'),
      batchNo: input.batchNo.trim(),
      herbId: input.herbId,
      methodId: input.methodId,
      feedKg: Number(input.feedKg) || 0,
      auxUsedKg: Number(input.auxUsedKg) || 0,
      fireLevel: input.fireLevel,
      temp: input.temp,
      duration: input.duration,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      yieldRate: Number(input.yieldRate) || 0,
      degree: input.degree,
      operator: input.operator.trim(),
      locked: lock,
      lockedAt: lock ? nowIso : undefined,
      currentVersion: lock ? 1 : undefined,
      decisions,
      remark: input.remark?.trim() || undefined,
    };
    await db.batches.put(batch);
    set({ batches: [batch, ...get().batches] });
    return batch;
  },

  updateBatch: async (id, patch) => {
    const current = get().batches.find((b) => b.id === id);
    if (!current) {
      return false;
    }
    if (current.locked) {
      // 已锁定批次不允许直接覆盖：改判必须走 rejudgeBatch 追加复核版本
      return false;
    }
    const next: ProcessBatch = { ...current, ...patch };
    await db.batches.put(next);
    set({ batches: get().batches.map((b) => (b.id === id ? next : b)) });
    return true;
  },

  removeBatch: async (id) => {
    await db.batches.delete(id);
    set({ batches: get().batches.filter((b) => b.id !== id) });
  },

  lockBatch: async (id, qcBy, reason) => {
    // 锁定与留样联动在同一事务内完成，任一写入失败整体回滚
    return db.transaction('rw', db.batches, db.samples, async () => {
      const stored = await db.batches.get(id);
      if (!stored) return undefined;

      const nowIso = new Date().toISOString();
      const existing = stored.decisions ?? [];
      const isRejudge = existing.length > 0;
      const version = existing.length + 1;
      const decision: BatchDecision = {
        version,
        kind: isRejudge ? '改判' : '初判',
        degree: stored.degree,
        yieldRate: stored.yieldRate,
        methodId: stored.methodId,
        fireLevel: stored.fireLevel,
        temp: stored.temp,
        duration: stored.duration,
        reason: reason ?? (isRejudge ? '质检员放行重锁：沿用编辑后判定' : '提交即锁定：班组初判'),
        qcBy: qcBy ?? (isRejudge ? '质检员 · 赵敏' : stored.operator),
        decidedAt: nowIso,
      };

      const next: ProcessBatch = {
        ...stored,
        locked: true,
        lockedAt: nowIso,
        qcBy: isRejudge ? decision.qcBy : stored.qcBy,
        decisions: [...existing, decision],
        currentVersion: version,
      };

      const samples = await db.samples.where('batchId').equals(id).toArray();
      const sideEffect: DecisionSideEffect = { heldSamples: [], updatedSamples: [] };
      samples.forEach((sample) => {
        if (sample.basisVersion === undefined) {
          // 首锁时绑定本次（初判）依据版本
          sample.basisVersion = version;
          sample.basisDegree = decision.degree;
          if (sample.reviewState === undefined) {
            sample.reviewState = '观察中';
          }
          sideEffect.updatedSamples.push(sample);
        }
      });
      // 放行重锁后程度若为太过，受影响的关联留样先待复核
      if (isRejudge && decision.degree === '太过') {
        sideEffect.heldSamples = collectHeld(samples, id, version - 1, `批次复判程度转为太过（v${version}）：${decision.reason}`);
        sideEffect.updatedSamples = samples;
      }

      await db.batches.put(next);
      if (sideEffect.updatedSamples.length) {
        await db.samples.bulkPut(sideEffect.updatedSamples);
      }

      // 提交成功后再更新内存状态，保证不会出现批次改了、留样没改的半改状态
      set({ batches: get().batches.map((b) => (b.id === id ? next : b)) });
      useSampleStore.getState().resync(sideEffect.updatedSamples);

      return { batch: next, heldSamples: sideEffect.heldSamples };
    });
  },

  rejudgeBatch: async (id, input) => {
    const reason = input.reason.trim();
    if (!reason) {
      throw new Error('改判必须填写复核理由');
    }

    // 批次版本追加与留样状态翻转在同一事务内完成：写入失败时原复核版本与留样状态均不变
    return db.transaction('rw', db.batches, db.samples, async () => {
      const stored = await db.batches.get(id);
      if (!stored) return undefined;
      if (!stored.locked) {
        throw new Error('仅已锁定批次可由质检员复核改判');
      }

      const existing = stored.decisions ?? [];
      const prevDecision = currentDecision(stored);
      const fromVersion = prevDecision?.version ?? existing.length;
      const version = existing.length + 1;
      const nowIso = new Date().toISOString();
      const decision: BatchDecision = {
        version,
        kind: '改判',
        degree: input.degree,
        yieldRate: Number(input.yieldRate) || 0,
        methodId: input.methodId,
        fireLevel: input.fireLevel,
        temp: input.temp,
        duration: input.duration,
        reason,
        qcBy: input.qcBy.trim() || '质检员 · 赵敏',
        decidedAt: nowIso,
      };

      const next: ProcessBatch = {
        ...stored,
        degree: decision.degree,
        yieldRate: decision.yieldRate,
        methodId: decision.methodId,
        fireLevel: decision.fireLevel,
        temp: decision.temp,
        duration: decision.duration,
        locked: true,
        qcBy: decision.qcBy,
        decisions: [...existing, decision],
        currentVersion: version,
      };

      // 程度转为太过：关联留样先待复核，等待质检员说明理由后沿用或重新取样
      const samples = await db.samples.where('batchId').equals(id).toArray();
      let heldSamples: RetainSample[] = [];
      if (input.degree === '太过' && prevDecision?.degree !== '太过') {
        const holdReason = `v${version} 改判程度转为太过（原 ${prevDecision?.degree ?? '-'}）：${reason}`;
        heldSamples = collectHeld(samples, id, fromVersion, holdReason);
      }

      await db.batches.put(next);
      if (heldSamples.length) {
        await db.samples.bulkPut(heldSamples);
      }

      // 事务提交成功后再更新内存状态
      set({ batches: get().batches.map((b) => (b.id === id ? next : b)) });
      useSampleStore.getState().resync(heldSamples);

      return { batch: next, heldSamples };
    });
  },

  unlockAsQc: async (id, qcBy) => {
    const current = get().batches.find((b) => b.id === id);
    if (!current) {
      return;
    }
    // 放行只解锁不改判定：已有的判定版本继续保留，重新锁定时追加改判版本
    const next: ProcessBatch = { ...current, locked: false, qcBy };
    await db.batches.put(next);
    set({ batches: get().batches.map((b) => (b.id === id ? next : b)) });
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
