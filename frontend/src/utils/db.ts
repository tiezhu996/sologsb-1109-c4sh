import Dexie, { type Table } from 'dexie';
import type { HerbMaterial } from '../types/herb-material';
import type { ProcessingMethod } from '../types/processing-method';
import type { BatchDecision, ProcessBatch } from '../types/process-batch';
import type { RetainSample } from '../types/retain-sample';

/** IndexedDB 库名（浏览器本地存储，无后端） */
export const DB_NAME = 'gbherbprocess-db';

/** 当前 schema 版本，与 db.version(n) 对应 */
export const SCHEMA_VERSION = 3;

/** 为旧数据补录的初判理由 */
export const MIGRATION_INITIAL_REASON = '历史数据补录：沿用原锁定判定（得率与程度复核）';
/** 为旧数据补录的待复核/升级标记理由 */
export const MIGRATION_SAMPLE_REASON = '历史数据升级：按原判定维持观察中';

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

    // v3：判定复核版本化。
    // - 已锁定批次补录 v1 初判依据（保留原程度/得率/方法/火候），旧结论不丢；
    // - 既有留样绑定该版依据并维持「观察中」，不因升级而翻转；
    // - samples 增加 reviewState 索引，便于查询改判后「待复核」的关联留样。
    this.version(3)
      .stores({
        herbs: 'id, name, origin, part, batchNo, receivedAt',
        methods: 'id, name, auxiliary, fireLevel',
        batches: 'id, batchNo, herbId, methodId, degree, startedAt, locked',
        samples: 'id, sampleNo, batchId, cabinet, retainedAt, reviewState',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        const batchTable = tx.table<ProcessBatch, string>('batches');
        const sampleTable = tx.table<RetainSample, string>('samples');

        const batchById = new Map<string, ProcessBatch>();
        await batchTable.toCollection().modify((row: ProcessBatch) => {
          if (typeof row.locked !== 'boolean') {
            row.locked = false;
          }
          // 已锁定批次补一版依据；已带流水的数据不重复补录
          if (row.locked && (!Array.isArray(row.decisions) || row.decisions.length === 0)) {
            const decision: BatchDecision = {
              version: 1,
              kind: '初判',
              degree: row.degree,
              yieldRate: row.yieldRate,
              methodId: row.methodId,
              fireLevel: row.fireLevel,
              temp: row.temp,
              duration: row.duration,
              reason: MIGRATION_INITIAL_REASON,
              qcBy: row.qcBy ?? row.operator,
              decidedAt: row.lockedAt ?? row.endedAt ?? new Date(0).toISOString(),
            };
            row.decisions = [decision];
            row.currentVersion = 1;
          }
          batchById.set(row.id, row);
        });

        await sampleTable.toCollection().modify((sample: RetainSample) => {
          // 既有留样维持观察中，仅补绑当时判定所依据的版本
          if (sample.reviewState === undefined) {
            sample.reviewState = '观察中';
          }
          if (sample.basisVersion === undefined) {
            const batch = batchById.get(sample.batchId);
            if (batch?.currentVersion !== undefined) {
              sample.basisVersion = batch.currentVersion;
              sample.basisDegree = batch.degree;
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
