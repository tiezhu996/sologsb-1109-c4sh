import 'fake-indexeddb/auto';
import { db, SCHEMA_VERSION } from '../src/utils/db';
import { useBatchStore } from '../src/stores/batchStore';
import { useSampleStore } from '../src/stores/sampleStore';
import type { ProcessBatch } from '../src/types/process-batch';
import type { RetainSample } from '../src/types/retain-sample';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}

async function resetDb() {
  await db.delete();
  await db.open();
  useBatchStore.setState({ batches: [], hydrated: true });
  useSampleStore.setState({ samples: [], hydrated: true });
}

function baseBatch(over: Partial<ProcessBatch> = {}): ProcessBatch {
  return {
    id: 'batch-t1',
    batchNo: 'PZ-TEST-1',
    herbId: 'herb-x',
    methodId: 'method-x',
    feedKg: 100,
    auxUsedKg: 0,
    fireLevel: '文火',
    startedAt: '2026-09-01T08:00:00.000Z',
    endedAt: '2026-09-01T08:20:00.000Z',
    yieldRate: 94,
    degree: '适中',
    operator: '陈玉兰',
    locked: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 场景 1：旧数据升级（v2 → v3）：已锁定批次补一版依据，既有留样维持观察中
// ---------------------------------------------------------------------------
async function testMigration() {
  console.log('场景 1：v2 → v3 旧数据升级');
  await db.delete();

  // 手动打开 v2 库写入旧形态数据（无 decisions / currentVersion / reviewState）
  const DexieMod = await import('dexie');
  const old = new DexieMod.default('gbherbprocess-db');
  old.version(1).stores({
    herbs: 'id',
    methods: 'id',
    batches: 'id, batchNo, herbId, methodId, degree, startedAt',
    samples: 'id, sampleNo, batchId, cabinet, retainedAt',
    meta: 'key',
  });
  old.version(2).stores({
    herbs: 'id',
    methods: 'id',
    batches: 'id, batchNo, herbId, methodId, degree, startedAt, locked',
    samples: 'id, sampleNo, batchId, cabinet, retainedAt',
    meta: 'key',
  });
  await old.table('batches').bulkPut([
    baseBatch({ id: 'b-lock', batchNo: 'L1', locked: true, lockedAt: '2026-09-02T00:00:00.000Z', qcBy: '质检员 · 赵敏' }),
    baseBatch({ id: 'b-open', batchNo: 'O1', locked: false }),
  ]);
  await old.table('samples').bulkPut([
    {
      id: 's1',
      sampleNo: 'LY-L1',
      batchId: 'b-lock',
      amountG: 300,
      retainMonths: 12,
      cabinet: 'A-01',
      retainedAt: '2026-09-03T00:00:00.000Z',
      observeLogs: [],
    },
    {
      id: 's2',
      sampleNo: 'LY-O1',
      batchId: 'b-open',
      amountG: 200,
      retainMonths: 6,
      cabinet: 'A-02',
      retainedAt: '2026-09-03T00:00:00.000Z',
      observeLogs: [],
    },
  ]);
  await old.close();

  await db.open();
  check('当前 schema 版本为 3', SCHEMA_VERSION === 3);

  const locked = await db.batches.get('b-lock');
  check('已锁定批次补录 decisions', Array.isArray(locked?.decisions) && locked!.decisions.length === 1, locked?.decisions);
  check('补录版本为 v1 初判', locked?.decisions?.[0].version === 1 && locked?.decisions?.[0].kind === '初判');
  check('v1 保留原程度/得率/方法/火候', locked?.decisions?.[0].degree === '适中' && locked?.decisions?.[0].yieldRate === 94 && locked?.decisions?.[0].methodId === 'method-x' && locked?.decisions?.[0].fireLevel === '文火');
  check('v1 带补录理由与判定人', Boolean(locked?.decisions?.[0].reason) && locked?.decisions?.[0].qcBy === '质检员 · 赵敏');
  check('currentVersion 回填为 1', locked?.currentVersion === 1);

  const open = await db.batches.get('b-open');
  check('未锁定批次不补版本', !open?.decisions?.length && open?.currentVersion === undefined);

  const s1 = await db.samples.get('s1');
  check('既有留样维持观察中', s1?.reviewState === '观察中', s1);
  check('既有留样绑定补录的 v1 依据', s1?.basisVersion === 1 && s1?.basisDegree === '适中');
  const s2 = await db.samples.get('s2');
  check('未锁定批次的留样不强行绑版本', s2?.basisVersion === undefined && s2?.reviewState === '观察中');

  await db.close();
}

// ---------------------------------------------------------------------------
// 场景 2：改判追加复核版本，旧程度/得率/方法/原因保留
// ---------------------------------------------------------------------------
async function testRejudgeKeepsHistory() {
  console.log('场景 2：改判版本化保留前后结论');
  await resetDb();

  const batch = await useBatchStore.getState().createBatch(
    {
      batchNo: 'PZ-T2',
      herbId: 'h1',
      methodId: 'm1',
      feedKg: 100,
      auxUsedKg: 0,
      fireLevel: '文火',
      temp: 105,
      duration: 12,
      startedAt: '2026-09-10T08:00:00.000Z',
      endedAt: '2026-09-10T08:12:00.000Z',
      yieldRate: 94,
      degree: '适中',
      operator: '陈玉兰',
    },
    true,
  );
  check('首锁即带 v1 初判', batch.currentVersion === 1 && batch.decisions?.length === 1);

  const s1 = await useSampleStore.getState().createSample({
    sampleNo: 'LY-T2',
    batchId: batch.id,
    amountG: 300,
    retainMonths: 12,
    cabinet: 'B-01',
    retainedAt: '2026-09-10T09:00:00.000Z',
  });
  check('新留样绑定 v1 依据', s1.basisVersion === 1 && s1.basisDegree === '适中' && s1.reviewState === '观察中');

  // 改判：适中 → 太过，得率与方法/火候同时调整
  const result = await useBatchStore.getState().rejudgeBatch(batch.id, {
    degree: '太过',
    yieldRate: 86.5,
    methodId: 'm2',
    fireLevel: '武火',
    temp: 170,
    duration: 20,
    reason: '断面焦褐、口尝焦苦，得率低于预期 6% 以上',
    qcBy: '质检员 · 赵敏',
  });
  check('改判后生成 v2', result?.batch.currentVersion === 2 && result.batch.decisions?.length === 2);
  check('批次顶层反映新结论', result?.batch.degree === '太过' && result?.batch.yieldRate === 86.5);
  check('v1 旧结论完整保留', (() => {
    const v1 = result?.batch.decisions?.[0];
    return v1?.degree === '适中' && v1.yieldRate === 94 && v1.methodId === 'm1' && v1.fireLevel === '文火' && Boolean(v1.reason);
  })());
  check('v1/v2 各自保留锅温与时长', (() => {
    const v1 = result?.batch.decisions?.[0];
    const v2 = result?.batch.decisions?.[1];
    return v1?.temp === 105 && v1.duration === 12 && v2?.temp === 170 && v2.duration === 20;
  })());
  check('v2 记录改判原因', result?.batch.decisions?.[1].reason.includes('焦苦') && result?.batch.decisions?.[1].kind === '改判');
  check('改判后批次仍锁定', result?.batch.locked === true);

  const held = await db.samples.get(s1.id);
  check('程度转为太过时关联留样待复核', held?.reviewState === '待复核', held);
  check('待复核原因已写入', held?.pendingReason?.includes('太过'));
  check('留样仍绑定其依据的 v1 版本（不被悄悄改绑）', held?.basisVersion === 1 && held?.basisDegree === '适中');

  // 未填理由必须拒绝
  let threw = false;
  try {
    await useBatchStore.getState().rejudgeBatch(batch.id, {
      degree: '不及',
      yieldRate: 90,
      methodId: 'm2',
      fireLevel: '武火',
      reason: '   ',
      qcBy: '质检员 · 赵敏',
    });
  } catch {
    threw = true;
  }
  check('改判原因为空时拒绝写入', threw);

  // 已锁定批次不允许 updateBatch 覆盖
  const updated = await useBatchStore.getState().updateBatch(batch.id, { degree: '不及' });
  check('updateBatch 拒绝覆盖已锁定批次', updated === false);
  const after = await db.batches.get(batch.id);
  check('拒绝后结论仍为 v2 太过', after?.degree === '太过' && after?.decisions?.length === 2);
}

// ---------------------------------------------------------------------------
// 场景 3：复核处置 —— 说明理由后沿用 / 重新取样
// ---------------------------------------------------------------------------
async function testReviewResolve() {
  console.log('场景 3：待复核留样沿用与重新取样');
  await resetDb();

  const batch = await useBatchStore.getState().createBatch(
    {
      batchNo: 'PZ-T3',
      herbId: 'h1',
      methodId: 'm1',
      feedKg: 100,
      auxUsedKg: 0,
      fireLevel: '文火',
      startedAt: '2026-09-10T08:00:00.000Z',
      endedAt: '2026-09-10T08:12:00.000Z',
      yieldRate: 94,
      degree: '适中',
      operator: '陈玉兰',
    },
    true,
  );
  const s1 = await useSampleStore.getState().createSample({
    sampleNo: 'LY-T3',
    batchId: batch.id,
    amountG: 300,
    retainMonths: 12,
    cabinet: 'B-02',
    retainedAt: '2026-09-10T09:00:00.000Z',
  });
  await useBatchStore.getState().rejudgeBatch(batch.id, {
    degree: '太过',
    yieldRate: 87,
    methodId: 'm1',
    fireLevel: '文火',
    reason: '焦苦',
    qcBy: '质检员 · 赵敏',
  });

  // 待复核期间禁止追加观察
  let blocked = false;
  try {
    await useSampleStore.getState().appendObserveLog(s1.id, {
      date: '2026-09-11',
      color: 'x',
      odor: 'x',
      mold: 'x',
      observer: '赵敏',
    });
  } catch {
    blocked = true;
  }
  check('待复核期间禁止追加观察', blocked);

  // 沿用
  const kept = await useSampleStore.getState().resolveReview(s1.id, {
    action: '沿用',
    reason: '留样外观气味稳定，太过仅影响成品放行，留样继续观察',
    qcBy: '质检员 · 赵敏',
  });
  check('沿用后恢复观察中', kept.sample.reviewState === '观察中');
  check('沿用留痕已写入', kept.sample.reviewLogs?.length === 1 && kept.sample.reviewLogs[0].action === '沿用');
  let observeThrew = false;
  try {
    await useSampleStore.getState().appendObserveLog(s1.id, {
      date: '2026-09-12', color: '正常', odor: '正常', mold: '无', observer: '赵敏',
    });
  } catch {
    observeThrew = true;
  }
  check('沿用后可继续追加观察', !observeThrew);
  const observeOk = await db.samples.get(s1.id);
  check('观察记录成功追加 1 条', observeOk?.observeLogs.length === 1);

  // 再改判：先回到适中（不翻转留样），再转为太过 → 重新待复核
  await useBatchStore.getState().rejudgeBatch(batch.id, {
    degree: '适中',
    yieldRate: 94,
    methodId: 'm1',
    fireLevel: '文火',
    reason: '二次评估推翻前判，恢复适中',
    qcBy: '质检员 · 赵敏',
  });
  const midSample = await db.samples.get(s1.id);
  check('转为非太过时不改变在用留样状态', midSample?.reviewState === '观察中');

  await useBatchStore.getState().rejudgeBatch(batch.id, {
    degree: '太过',
    yieldRate: 85,
    methodId: 'm1',
    fireLevel: '文火',
    reason: '再次复查仍有焦苦',
    qcBy: '质检员 · 赵敏',
  });
  const again = await db.samples.get(s1.id);
  check('程度再次转为太过时重新置为待复核', again?.reviewState === '待复核');

  const resampled = await useSampleStore.getState().resolveReview(s1.id, {
    action: '重新取样',
    reason: '原留样储存条件异常，重新取样',
    qcBy: '质检员 · 赵敏',
    newSample: {
      sampleNo: 'LY-T3-R1',
      batchId: batch.id,
      amountG: 400,
      retainMonths: 12,
      cabinet: 'B-03',
      retainedAt: '2026-09-20T00:00:00.000Z',
    },
  });
  check('旧留样作废', resampled.sample.reviewState === '已作废');
  check('旧留样留痕指向新留样', resampled.sample.reviewLogs?.[1]?.newSampleNo === 'LY-T3-R1');
  check('新留样绑定当前 v4 依据（序列 v1 适中→v2 太过→v3 适中→v4 太过）', resampled.newSample?.basisVersion === 4 && resampled.newSample?.basisDegree === '太过', resampled.newSample);
  check('新留样为观察中', resampled.newSample?.reviewState === '观察中');

  let voidedObserveThrew = false;
  try {
    await useSampleStore.getState().appendObserveLog(s1.id, {
      date: '2026-09-21', color: 'x', odor: 'x', mold: 'x', observer: '赵敏',
    });
  } catch {
    voidedObserveThrew = true;
  }
  check('作废留样禁止追加观察', voidedObserveThrew);
}

// ---------------------------------------------------------------------------
// 场景 4：写入失败时原复核版本与留样状态不能半改（事务原子性）
// ---------------------------------------------------------------------------
async function testAtomicity() {
  console.log('场景 4：写入失败的原子回滚');

  // 4a. rejudgeBatch：samples.bulkPut 失败 → 批次也不得追加版本
  await resetDb();
  const batch = await useBatchStore.getState().createBatch(
    {
      batchNo: 'PZ-T4',
      herbId: 'h1',
      methodId: 'm1',
      feedKg: 100,
      auxUsedKg: 0,
      fireLevel: '文火',
      startedAt: '2026-09-10T08:00:00.000Z',
      endedAt: '2026-09-10T08:12:00.000Z',
      yieldRate: 94,
      degree: '适中',
      operator: '陈玉兰',
    },
    true,
  );
  const s1 = await useSampleStore.getState().createSample({
    sampleNo: 'LY-T4',
    batchId: batch.id,
    amountG: 300,
    retainMonths: 12,
    cabinet: 'C-01',
    retainedAt: '2026-09-10T09:00:00.000Z',
  });

  const originalBulkPut = db.samples.bulkPut.bind(db.samples);
  db.samples.bulkPut = () => Promise.reject(new Error('模拟留样写入失败'));
  let threw = false;
  try {
    await useBatchStore.getState().rejudgeBatch(batch.id, {
      degree: '太过',
      yieldRate: 85,
      methodId: 'm1',
      fireLevel: '文火',
      reason: '模拟原子性测试',
      qcBy: '质检员 · 赵敏',
    });
  } catch (error) {
    threw = (error as Error).message.includes('模拟留样写入失败');
  }
  db.samples.bulkPut = originalBulkPut;

  check('rejudge 失败已抛出', threw);
  const batchAfter = await db.batches.get(batch.id);
  check('批次未追加 v2（无半改）', batchAfter?.decisions?.length === 1 && batchAfter.degree === '适中', batchAfter?.decisions?.length);
  const sampleAfter = await db.samples.get(s1.id);
  check('留样未变为待复核（无半改）', sampleAfter?.reviewState === '观察中', sampleAfter?.reviewState);
  const memBatch = useBatchStore.getState().batches.find((b) => b.id === batch.id);
  check('内存中的批次也未半改', memBatch?.decisions?.length === 1 && memBatch.degree === '适中');

  // 4b. resolveReview 重新取样：新留样写入失败 → 旧留样不得作废
  await useBatchStore.getState().rejudgeBatch(batch.id, {
    degree: '太过',
    yieldRate: 85,
    methodId: 'm1',
    fireLevel: '文火',
    reason: '置为待复核用',
    qcBy: '质检员 · 赵敏',
  });
  db.samples.bulkPut = () => Promise.reject(new Error('模拟新留样写入失败'));
  let threw2 = false;
  try {
    await useSampleStore.getState().resolveReview(s1.id, {
      action: '重新取样',
      reason: '原子性测试',
      qcBy: '质检员 · 赵敏',
      newSample: {
        sampleNo: 'LY-T4-RX',
        batchId: batch.id,
        amountG: 300,
        retainMonths: 12,
        cabinet: 'C-02',
        retainedAt: '2026-09-20T00:00:00.000Z',
      },
    });
  } catch (error) {
    threw2 = (error as Error).message.includes('模拟新留样写入失败');
  }
  db.samples.bulkPut = originalBulkPut;
  check('resolveReview 失败已抛出', threw2);
  const held = await db.samples.get(s1.id);
  check('旧留样仍为待复核，未半改为已作废', held?.reviewState === '待复核' && (held.reviewLogs?.length ?? 0) === 0, held);
  const orphan = await db.samples.where('batchId').equals(batch.id).toArray();
  check('没有产生孤儿新留样', orphan.length === 1, orphan.map((o) => o.id));

  // 4c. 失败后可正常重试成功（证明状态机未损坏）
  const retried = await useSampleStore.getState().resolveReview(s1.id, {
    action: '沿用',
    reason: '写入恢复后沿用',
    qcBy: '质检员 · 赵敏',
  });
  check('故障恢复后可沿用成功', retried.sample.reviewState === '观察中');
}

async function main() {
  try {
    await testMigration();
    await testRejudgeKeepsHistory();
    await testReviewResolve();
    await testAtomicity();
  } catch (error) {
    console.error('测试执行异常：', error);
    failures += 1;
  } finally {
    await db.close();
  }
  if (failures > 0) {
    console.error(`\n${failures} 项检查未通过`);
    process.exit(1);
  }
  console.log('\n全部检查通过');
}

main();
