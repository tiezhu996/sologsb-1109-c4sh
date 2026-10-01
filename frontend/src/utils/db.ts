import Dexie, { type Table } from 'dexie';
import type { HerbMaterial } from '../types/herb-material';
import type { ProcessingMethod } from '../types/processing-method';
import type { BatchReview, ProcessBatch } from '../types/process-batch';
import type { RetainSample } from '../types/retain-sample';
import { uid } from './id';

/** IndexedDB 库名（浏览器本地存储，无后端） */
export const DB_NAME = 'gbherbprocess-db';

/** 当前 schema 版本，与 db.version(n) 对应 */
export const SCHEMA_VERSION = 3;

class HerbProcessDB extends Dexie {
  herbs!: Table<HerbMaterial, string>;
  methods!: Table<ProcessingMethod, string>;
  batches!: Table<ProcessBatch, string>;
  samples!: Table<RetainSample, string>;
  meta!: Table<{ key: string; value: string }, string>;

  constructor() {
    super(DB_NAME);

    // v1：建表声明索引
    this.version(1).stores({
      herbs: 'id, name, origin, part, batchNo, receivedAt',
      methods: 'id, name, auxiliary, fireLevel',
      batches: 'id, batchNo, herbId, methodId, degree, startedAt',
      samples: 'id, sampleNo, batchId, cabinet, retainedAt',
      meta: 'key',
    });

    // v2：批次表增加 locked 索引（锁定/质检放行查询更快），并回填历史数据的 locked 字段。
    // 升级前请在「导出备份」中导出 JSON。
    this.version(2)
      .stores({
        herbs: 'id, name, origin, part, batchNo, receivedAt',
        methods: 'id, name, auxiliary, fireLevel',
        batches: 'id, batchNo, herbId, methodId, degree, startedAt, locked',
        samples: 'id, sampleNo, batchId, cabinet, retainedAt',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        await tx
          .table('batches')
          .toCollection()
          .modify((row: ProcessBatch) => {
            if (typeof row.locked !== 'boolean') {
              row.locked = false;
            }
          });
      });

    // v3：改判改为复核版本链。为已锁定批次补一版初判依据（完整快照、只增不改），
    // 既有留样维持「观察中」并绑定该初判版本；未锁定批次暂无版本，锁定时再补。
    this.version(3)
      .stores({
        herbs: 'id, name, origin, part, batchNo, receivedAt',
        methods: 'id, name, auxiliary, fireLevel',
        batches: 'id, batchNo, herbId, methodId, degree, startedAt, locked',
        samples: 'id, sampleNo, batchId, cabinet, retainedAt, reviewState',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        // batchId -> 初判版本 id
        const baseline = new Map<string, string>();

        await tx
          .table<ProcessBatch, string>('batches')
          .toCollection()
          .modify((batch) => {
            if (Array.isArray(batch.reviews) && batch.reviews.length > 0) {
              batch.reviews.forEach((r) => {
                if (r.version === 1) baseline.set(batch.id, r.id);
              });
              return;
            }
            if (!batch.locked) {
              batch.reviews = [];
              return;
            }
            const review: BatchReview = {
              id: uid('review'),
              version: 1,
              kind: '初判',
              judgedAt: batch.lockedAt ?? batch.endedAt,
              judgeBy: batch.qcBy ?? batch.operator,
              degree: batch.degree,
              yieldRate: batch.yieldRate,
              methodId: batch.methodId,
              fireLevel: batch.fireLevel,
              reason: '数据升级前的初判结论（历史锁定批次补录依据）',
            };
            batch.reviews = [review];
            baseline.set(batch.id, review.id);
          });

        // 既有留样维持观察中，绑定本批补录的初判版本
        await tx
          .table<RetainSample, string>('samples')
          .toCollection()
          .modify((sample) => {
            if (sample.reviewState !== 'pending' && sample.reviewState !== 'keep') {
              sample.reviewState = 'observing';
            }
            if (!sample.reviewId) {
              const reviewId = baseline.get(sample.batchId);
              if (reviewId) {
                sample.reviewId = reviewId;
              }
            }
          });
      });
  }
}

export const db = new HerbProcessDB();

export async function getMeta(key: string): Promise<string | undefined> {
  const row = await db.meta.get(key);
  return row?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}
