import { useMemo, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import StatBadge from '../components/common/StatBadge';
import CabinetGrid from '../components/common/CabinetGrid';
import EmptyPanel from '../components/common/EmptyPanel';
import { useSampleStore, type ResolveReviewInput } from '../stores/sampleStore';
import { useBatchStore } from '../stores/batchStore';
import { useHerbStore } from '../stores/herbStore';
import { CABINETS, SAMPLE_REVIEW_LABEL, type ObserveLog, type RetainSample, type SampleExpiry, type SampleReviewState } from '../types/retain-sample';
import { buildExpiryList, formatDate, todayStr } from '../utils/degree';
import { batchReviewOf, isSampleStale, latestReview, sampleReviewState } from '../utils/review';
import type { ProcessDegree } from '../types/process-batch';

const { Title, Paragraph, Text } = Typography;

interface SampleFormValues {
  sampleNo: string;
  batchId: string;
  amountG: number;
  retainMonths: number;
  cabinet: string;
  retainedAt: Dayjs;
}

interface ObserveFormValues {
  date: Dayjs;
  color: string;
  odor: string;
  mold: string;
  observer: string;
  note?: string;
}

interface ResolveFormValues {
  by: string;
  reason: string;
  action: '沿用' | '重新取样';
  sampleNo: string;
  amountG: number;
  retainMonths: number;
  cabinet: string;
  retainedAt: Dayjs;
}

const STATE_COLOR: Record<SampleExpiry['state'], string> = { 已到期: 'red', 临期: 'orange', 观察中: 'green' };

const REVIEW_COLOR: Record<SampleReviewState, string> = {
  observing: 'green',
  pending: 'red',
  keep: 'blue',
  resampled: 'default',
};

const DEGREE_COLOR: Record<ProcessDegree, string> = { 不及: 'orange', 适中: 'green', 太过: 'red' };

/** 留样与观察台账：按柜位网格查看并追加观察记录 */
export default function SampleLedger() {
  const { message } = AntApp.useApp();
  const samples = useSampleStore((s) => s.samples);
  const createSample = useSampleStore((s) => s.createSample);
  const removeSample = useSampleStore((s) => s.removeSample);
  const appendObserveLog = useSampleStore((s) => s.appendObserveLog);
  const resolveSampleReview = useSampleStore((s) => s.resolveSampleReview);
  const batches = useBatchStore((s) => s.batches);
  const herbs = useHerbStore((s) => s.herbs);

  const [selectedCabinet, setSelectedCabinet] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<SampleFormValues>();
  const [observeTarget, setObserveTarget] = useState<RetainSample | null>(null);
  const [observeForm] = Form.useForm<ObserveFormValues>();
  const [reviewTarget, setReviewTarget] = useState<RetainSample | null>(null);
  const [reviewForm] = Form.useForm<ResolveFormValues>();
  const resolveAction = Form.useWatch('action', reviewForm) as ResolveFormValues['action'] | undefined;

  const batchById = useMemo(() => new Map(batches.map((b) => [b.id, b])), [batches]);

  /** 到期派生清单，补入留样绑定版本的程度/版本号与是否已被取代 */
  const expiryList = useMemo(
    () =>
      buildExpiryList(samples, 30).map((item) => {
        const batch = batchById.get(item.sample.batchId);
        const bound = batch ? batchReviewOf(batch, item.sample.reviewId) : undefined;
        return {
          ...item,
          boundDegree: bound?.degree,
          boundVersion: bound?.version,
          stale: isSampleStale(batch, item.sample),
        };
      }),
    [samples, batchById],
  );
  const dueList = useMemo(() => expiryList.filter((item) => item.daysLeft <= 30), [expiryList]);
  const expired = useMemo(() => expiryList.filter((item) => item.daysLeft < 0), [expiryList]);
  const pendingList = useMemo(
    () => samples.filter((s) => sampleReviewState(s) === 'pending'),
    [samples],
  );

  const visible = useMemo(
    () => (selectedCabinet ? expiryList.filter((item) => item.sample.cabinet === selectedCabinet) : expiryList),
    [expiryList, selectedCabinet],
  );

  const batchLabel = (batchId: string) => {
    const batch = batchById.get(batchId);
    if (!batch) return '未知批次';
    const herb = herbs.find((h) => h.id === batch.herbId);
    return `${batch.batchNo} · ${herb?.name ?? '未知药材'} · 得率 ${batch.yieldRate}%`;
  };

  const openCreate = () => {
    const nextIndex = samples.length + 1;
    const batch = batches[0];
    form.resetFields();
    form.setFieldsValue({
      sampleNo: `LY-${batch?.batchNo ?? 'NEW'}-${String(nextIndex).padStart(2, '0')}`,
      batchId: batch?.id,
      amountG: 300,
      retainMonths: 12,
      cabinet: CABINETS.find((c) => !expiryList.some((item) => item.sample.cabinet === c)) ?? CABINETS[0],
      retainedAt: dayjs(),
    } as unknown as SampleFormValues);
    setOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    const occupied = expiryList.some((item) => item.sample.cabinet === values.cabinet);
    if (occupied) {
      message.warning(`柜位 ${values.cabinet} 已有留样，仍将并存放置`);
    }
    await createSample({
      sampleNo: values.sampleNo,
      batchId: values.batchId,
      amountG: values.amountG,
      retainMonths: values.retainMonths,
      cabinet: values.cabinet,
      retainedAt: values.retainedAt.toISOString(),
    });
    const bound = latestReview(batchById.get(values.batchId));
    message.success(`已登记留样 ${values.sampleNo}，绑定判定版本 v${bound?.version ?? '-'}`);
    setOpen(false);
  };

  const openObserve = (record: RetainSample) => {
    setObserveTarget(record);
    observeForm.resetFields();
    observeForm.setFieldsValue({ date: dayjs(), color: '色泽符合标准', odor: '气味正常', mold: '无霉变', observer: '赵敏' } as unknown as ObserveFormValues);
  };

  const submitObserve = async () => {
    if (!observeTarget) return;
    const values = await observeForm.validateFields();
    await appendObserveLog(observeTarget.id, {
      date: values.date.format('YYYY-MM-DD'),
      color: values.color,
      odor: values.odor,
      mold: values.mold,
      observer: values.observer,
      note: values.note,
    });
    const refreshed = useSampleStore.getState().samples.find((s) => s.id === observeTarget.id);
    if (refreshed) {
      setObserveTarget(refreshed);
    }
    message.success('观察记录已按日期追加');
  };

  /** 打开待复核处置弹窗（沿用 / 重新取样） */
  const openResolve = (record: RetainSample) => {
    setReviewTarget(record);
    const batch = batchById.get(record.batchId);
    reviewForm.resetFields();
    reviewForm.setFieldsValue({
      by: '质检员 · 赵敏',
      reason: '',
      action: '沿用',
      sampleNo: `LY-${batch?.batchNo ?? 'NEW'}-复${String(samples.length + 1).padStart(2, '0')}`,
      amountG: 300,
      retainMonths: 12,
      cabinet: CABINETS.find((c) => !expiryList.some((item) => item.sample.cabinet === c)) ?? CABINETS[0],
      retainedAt: dayjs(),
    } as unknown as ResolveFormValues);
  };

  const submitResolve = async () => {
    if (!reviewTarget) return;
    const values = await reviewForm.validateFields();
    const payload: ResolveReviewInput = {
      by: values.by,
      reason: values.reason,
      action: values.action,
    };
    if (values.action === '重新取样') {
      payload.newSample = {
        sampleNo: values.sampleNo,
        amountG: values.amountG,
        retainMonths: values.retainMonths,
        cabinet: values.cabinet,
        retainedAt: values.retainedAt.toISOString(),
      };
    }
    try {
      const created = await resolveSampleReview(reviewTarget.id, payload);
      if (values.action === '重新取样' && created) {
        const batch = batchById.get(reviewTarget.batchId);
        message.success(`已登记新留样 ${created.sampleNo}（绑定 v${latestReview(batch)?.version ?? '-'}），旧留样留存备查`);
      } else {
        message.success('已说明理由，原留样继续按原判定版本观察');
      }
      setReviewTarget(null);
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const columns: TableColumnsType<SampleExpiry> = [
    { title: '留样编号', width: 170, render: (_, row) => <Text strong>{row.sample.sampleNo}</Text> },
    { title: '关联批次', width: 240, render: (_, row) => batchLabel(row.sample.batchId) },
    {
      title: '判定依据 / 复核',
      width: 200,
      render: (_, row) => {
        const state = sampleReviewState(row.sample);
        return (
          <Space size={4} wrap>
            {row.boundVersion ? (
              <Tag color={row.boundDegree ? DEGREE_COLOR[row.boundDegree] : 'default'}>
                依据 v{row.boundVersion} · {row.boundDegree ?? '-'}
              </Tag>
            ) : (
              <Tag>未绑定版本</Tag>
            )}
            {row.stale ? <Tag color="gold">已有新版</Tag> : null}
            <Tag color={REVIEW_COLOR[state]}>{SAMPLE_REVIEW_LABEL[state]}</Tag>
          </Space>
        );
      },
    },
    { title: '留样量(g)', width: 90, align: 'right', render: (_, row) => row.sample.amountG },
    { title: '留样期(月)', width: 90, align: 'right', render: (_, row) => row.sample.retainMonths },
    { title: '柜位', width: 80, render: (_, row) => <Tag color="green">{row.sample.cabinet}</Tag> },
    { title: '留样日期', width: 100, render: (_, row) => formatDate(row.sample.retainedAt) },
    { title: '到期日', width: 100, render: (_, row) => row.expireAt },
    {
      title: '剩余天数',
      width: 100,
      align: 'right',
      render: (_, row) => (
        <Text type={row.daysLeft < 0 ? 'danger' : row.daysLeft <= 30 ? 'warning' : undefined}>
          {row.daysLeft < 0 ? `过期 ${Math.abs(row.daysLeft)} 天` : `${row.daysLeft} 天`}
        </Text>
      ),
    },
    { title: '到期状态', width: 90, render: (_, row) => <Tag color={STATE_COLOR[row.state]}>{row.state}</Tag> },
    { title: '观察记录', width: 80, align: 'right', render: (_, row) => `${row.sample.observeLogs.length} 条` },
    {
      title: '操作',
      width: 210,
      fixed: 'right',
      render: (_, row) => {
        const state = sampleReviewState(row.sample);
        return (
          <Space size={2}>
            {state === 'pending' ? (
              <Button size="small" type="link" danger onClick={() => openResolve(row.sample)}>
                复核处置
              </Button>
            ) : null}
            <Button size="small" type="link" disabled={state === 'resampled'} onClick={() => openObserve(row.sample)}>
              追加观察
            </Button>
            <Popconfirm title={`确认删除留样 ${row.sample.sampleNo}？`} onConfirm={() => removeSample(row.sample.id).then(() => message.success('已删除'))}>
              <Button size="small" type="link" danger>
                删除
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  const observeColumns: TableColumnsType<ObserveLog> = [
    { title: '观察日期', dataIndex: 'date', width: 110 },
    { title: '色泽', dataIndex: 'color', width: 140 },
    { title: '气味', dataIndex: 'odor', width: 120 },
    { title: '霉变', dataIndex: 'mold', width: 120 },
    { title: '观察人', dataIndex: 'observer', width: 90 },
    { title: '备注', dataIndex: 'note', render: (v?: string) => v ?? '-' },
  ];

  const observeTargetBatch = observeTarget ? batchById.get(observeTarget.batchId) : undefined;
  const observeTargetReview = observeTarget ? batchReviewOf(observeTargetBatch, observeTarget.reviewId) : undefined;

  const reviewTargetBatch = reviewTarget ? batchById.get(reviewTarget.batchId) : undefined;
  const reviewTargetBound = reviewTarget ? batchReviewOf(reviewTargetBatch, reviewTarget.reviewId) : undefined;
  const reviewTargetLatest = latestReview(reviewTargetBatch);

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        留样与观察台账
      </Title>
      <Paragraph type="secondary">
        留样绑定登记时批次的判定版本，复核改判不影响既有留样的观察依据；关联批次改判为「太过」时留样先进入待复核，质检员说明理由后可沿用原留样或重新取样。
      </Paragraph>

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={8} lg={4}>
          <StatBadge label="留样总数" value={samples.length} unit="份" />
        </Col>
        <Col xs={12} md={8} lg={5}>
          <StatBadge label="待复核留样" value={pendingList.length} unit="份" status={pendingList.length ? 'error' : 'success'} hint="关联批次改判为「太过」，待质检员处置" />
        </Col>
        <Col xs={12} md={8} lg={5}>
          <StatBadge label="观察中" value={expiryList.filter((i) => i.daysLeft > 30).length} unit="份" status="success" />
        </Col>
        <Col xs={12} md={8} lg={5}>
          <StatBadge label="30 天内到期" value={dueList.length - expired.length} unit="份" status="warning" />
        </Col>
        <Col xs={12} md={8} lg={5}>
          <StatBadge label="已到期" value={expired.length} unit="份" status={expired.length ? 'error' : 'success'} />
        </Col>
      </Row>

      {pendingList.length > 0 ? (
        <Alert
          style={{ marginBottom: 16 }}
          type="error"
          showIcon
          message={`${pendingList.length} 份留样待复核：关联批次复核改判为「太过」，请质检员说明理由后沿用或重新取样`}
          description={
            <Space wrap>
              {pendingList.slice(0, 8).map((s) => {
                const batch = batchById.get(s.batchId);
                return (
                  <Tag key={s.id} color="red">
                    {s.sampleNo}（{batch?.batchNo ?? '未知批次'}，依据 v{batchReviewOf(batch, s.reviewId)?.version ?? '-'}）
                  </Tag>
                );
              })}
            </Space>
          }
        />
      ) : null}

      <Card
        size="small"
        title="留样柜位网格"
        style={{ marginBottom: 16 }}
        extra={
          <Space>
            {selectedCabinet ? <Tag color="green">已选柜位 {selectedCabinet}</Tag> : <Text type="secondary">点击柜位可筛选下方台账</Text>}
            {selectedCabinet ? <Button size="small" onClick={() => setSelectedCabinet(undefined)}>清除柜位筛选</Button> : null}
            <Button size="small" type="primary" onClick={openCreate}>
              登记留样
            </Button>
          </Space>
        }
      >
        <CabinetGrid expiryList={expiryList} selected={selectedCabinet} onSelect={(cabinet) => setSelectedCabinet(cabinet)} />
      </Card>

      {visible.length === 0 ? (
        <EmptyPanel description={selectedCabinet ? `柜位 ${selectedCabinet} 暂无留样` : '暂无留样记录'} actionText="登记留样" onAction={openCreate} />
      ) : (
        <Table rowKey={(row) => row.sample.id} size="small" columns={columns} dataSource={visible} pagination={{ pageSize: 8 }} scroll={{ x: 1620 }} />
      )}

      <Modal open={open} title="登记留样" onCancel={() => setOpen(false)} onOk={submit} okText="保存" cancelText="取消" width={560}>
        <Form form={form} layout="vertical">
          <Alert type="info" showIcon style={{ marginBottom: 12 }} message="留样将自动绑定该批次当前最新判定版本，后续复核改判不改变本留样的依据版本。" />
          <Form.Item name="sampleNo" label="留样编号" rules={[{ required: true, message: '请输入留样编号' }]}>
            <Input maxLength={32} />
          </Form.Item>
          <Form.Item name="batchId" label="关联炮制批次" rules={[{ required: true, message: '请选择关联批次' }]}>
            <Select showSearch optionFilterProp="label" options={batches.map((b) => ({ label: batchLabel(b.id), value: b.id }))} />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="amountG" label="留样量(g)" rules={[{ required: true, message: '请输入留样量' }]}>
              <InputNumber min={0} style={{ width: 150 }} />
            </Form.Item>
            <Form.Item name="retainMonths" label="留样期(月)" rules={[{ required: true, message: '请选择留样期' }]}>
              <Select style={{ width: 150 }} options={[3, 6, 12, 18, 24, 36].map((m) => ({ label: `${m} 个月`, value: m }))} />
            </Form.Item>
          </Space>
          <Form.Item name="cabinet" label="柜位" rules={[{ required: true, message: '请选择柜位' }]}>
            <Select showSearch options={CABINETS.map((c) => ({ label: c, value: c }))} />
          </Form.Item>
          <Form.Item name="retainedAt" label="留样日期" rules={[{ required: true, message: '请选择留样日期' }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={Boolean(observeTarget)}
        title={`留样观察记录 · ${observeTarget?.sampleNo ?? ''}`}
        onCancel={() => setObserveTarget(null)}
        footer={null}
        width={760}
      >
        {observeTarget ? (
          <Alert
            type={sampleReviewState(observeTarget) === 'pending' ? 'error' : 'info'}
            showIcon
            style={{ marginBottom: 12 }}
            message={
              <Space wrap>
                <span>
                  依据判定版本：v{observeTargetReview?.version ?? '-'}（{observeTargetReview?.kind ?? '-'}，
                  <Tag color={observeTargetReview ? DEGREE_COLOR[observeTargetReview.degree] : 'default'} style={{ marginInline: 2 }}>
                    {observeTargetReview?.degree ?? '-'}
                  </Tag>
                  得率 {observeTargetReview?.yieldRate ?? '-'}%）
                </span>
                <Tag color={REVIEW_COLOR[sampleReviewState(observeTarget)]}>{SAMPLE_REVIEW_LABEL[sampleReviewState(observeTarget)]}</Tag>
              </Space>
            }
            description={
              sampleReviewState(observeTarget) === 'pending'
                ? observeTarget.pendingReason
                : observeTarget.reviewNote
                  ? `处置：${observeTarget.reviewNote.action}（${observeTarget.reviewNote.by}，${formatDate(observeTarget.reviewNote.at)}）——${observeTarget.reviewNote.reason}`
                  : '观察记录按该版本判定结论持续追加。'
            }
          />
        ) : null}
        <Table
          rowKey="id"
          size="small"
          style={{ marginBottom: 12 }}
          columns={observeColumns}
          dataSource={observeTarget?.observeLogs ?? []}
          pagination={false}
          locale={{ emptyText: '暂无观察记录，请在下方追加' }}
        />
        <Form form={observeForm} layout="vertical">
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="date" label="观察日期" rules={[{ required: true, message: '请选择观察日期' }]}>
              <DatePicker style={{ width: 170 }} />
            </Form.Item>
            <Form.Item name="observer" label="观察人" rules={[{ required: true, message: '请输入观察人' }]}>
              <Input style={{ width: 140 }} maxLength={16} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="color" label="色泽" rules={[{ required: true, message: '请填写色泽观察' }]}>
              <Input style={{ width: 200 }} maxLength={30} />
            </Form.Item>
            <Form.Item name="odor" label="气味" rules={[{ required: true, message: '请填写气味观察' }]}>
              <Input style={{ width: 200 }} maxLength={30} />
            </Form.Item>
            <Form.Item name="mold" label="霉变" rules={[{ required: true, message: '请填写霉变观察' }]}>
              <Input style={{ width: 200 }} maxLength={30} />
            </Form.Item>
          </Space>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} maxLength={80} />
          </Form.Item>
          <Space>
            <Button type="primary" onClick={submitObserve}>
              追加本次观察（{todayStr()}）
            </Button>
            <Button onClick={() => setObserveTarget(null)}>关闭</Button>
          </Space>
        </Form>
      </Modal>

      <Modal
        open={Boolean(reviewTarget)}
        title={`留样复核处置 · ${reviewTarget?.sampleNo ?? ''}`}
        onCancel={() => setReviewTarget(null)}
        onOk={submitResolve}
        okText="提交处置"
        cancelText="取消"
        width={620}
      >
        {reviewTarget ? (
          <Form form={reviewForm} layout="vertical">
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              message="该留样关联批次已被复核改判为「太过」，须先由质检员处置"
              description={reviewTarget.pendingReason}
            />
            <Card size="small" style={{ marginBottom: 12 }}>
              <Space direction="vertical" size={2}>
                <Text>
                  留样原依据：
                  <Tag color={reviewTargetBound ? DEGREE_COLOR[reviewTargetBound.degree] : 'default'}>
                    v{reviewTargetBound?.version ?? '-'} · {reviewTargetBound?.degree ?? '-'}
                  </Tag>
                  得率 {reviewTargetBound?.yieldRate ?? '-'}% · {reviewTargetBound?.reason}
                </Text>
                <Text>
                  批次最新判定：
                  <Tag color={reviewTargetLatest ? DEGREE_COLOR[reviewTargetLatest.degree] : 'default'}>
                    v{reviewTargetLatest?.version ?? '-'} · {reviewTargetLatest?.degree ?? '-'}
                  </Tag>
                  得率 {reviewTargetLatest?.yieldRate ?? '-'}%
                </Text>
              </Space>
            </Card>
            <Form.Item name="by" label="处置质检员" rules={[{ required: true, message: '请填写质检员' }]}>
              <Input maxLength={16} />
            </Form.Item>
            <Form.Item name="action" label="处置方式" rules={[{ required: true }]}>
              <Select
                options={[
                  { label: '沿用原留样：说明理由后继续按原版本观察', value: '沿用' },
                  { label: '重新取样：登记新留样并绑定最新判定版本，旧样留存备查', value: '重新取样' },
                ]}
              />
            </Form.Item>
            <Form.Item name="reason" label="理由说明（必填，写入留样处置留痕）" rules={[{ required: true, message: '请说明处置理由' }]}>
              <Input.TextArea rows={3} maxLength={200} showCount placeholder="如：经复检留样断面、气味均符合标准，判定差异系锅温测点偏差，沿用原留样继续观察" />
            </Form.Item>

            {resolveAction === '重新取样' ? (
              <Card size="small" type="inner" title="新留样登记（绑定最新判定版本）">
                <Form.Item name="sampleNo" label="留样编号" rules={[{ required: true, message: '请输入留样编号' }]}>
                  <Input maxLength={32} />
                </Form.Item>
                <Space size={12} style={{ display: 'flex' }} align="start">
                  <Form.Item name="amountG" label="留样量(g)" rules={[{ required: true, message: '请输入留样量' }]}>
                    <InputNumber min={0} style={{ width: 150 }} />
                  </Form.Item>
                  <Form.Item name="retainMonths" label="留样期(月)" rules={[{ required: true, message: '请选择留样期' }]}>
                    <Select style={{ width: 150 }} options={[3, 6, 12, 18, 24, 36].map((m) => ({ label: `${m} 个月`, value: m }))} />
                  </Form.Item>
                </Space>
                <Form.Item name="cabinet" label="柜位" rules={[{ required: true, message: '请选择柜位' }]}>
                  <Select showSearch options={CABINETS.map((c) => ({ label: c, value: c }))} />
                </Form.Item>
                <Form.Item name="retainedAt" label="留样日期" rules={[{ required: true, message: '请选择留样日期' }]}>
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
              </Card>
            ) : null}
          </Form>
        ) : null}
      </Modal>
    </div>
  );
}
