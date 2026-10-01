import { useMemo, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Radio, Row, Select, Space, Switch, Table, Tag, Timeline, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import StatBadge from '../components/common/StatBadge';
import CabinetGrid from '../components/common/CabinetGrid';
import EmptyPanel from '../components/common/EmptyPanel';
import { useSampleStore } from '../stores/sampleStore';
import { useBatchStore } from '../stores/batchStore';
import { useHerbStore } from '../stores/herbStore';
import { basisDecision, currentDecision } from '../utils/decision';
import { CABINETS, type ObserveLog, type RetainSample, type SampleExpiry, type SampleReviewAction } from '../types/retain-sample';
import { buildExpiryList, formatDate, todayStr } from '../utils/degree';

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

interface ReviewFormValues {
  action: SampleReviewAction;
  reason: string;
  qcBy: string;
  newSampleNo?: string;
  newAmountG?: number;
  newRetainMonths?: number;
  newCabinet?: string;
  newRetainedAt?: Dayjs;
}

const STATE_COLOR: Record<SampleExpiry['state'], string> = { 已到期: 'red', 临期: 'orange', 观察中: 'green' };

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 留样与观察台账：按柜位网格查看并追加观察记录 */
export default function SampleLedger() {
  const { message } = AntApp.useApp();
  const samples = useSampleStore((s) => s.samples);
  const createSample = useSampleStore((s) => s.createSample);
  const removeSample = useSampleStore((s) => s.removeSample);
  const appendObserveLog = useSampleStore((s) => s.appendObserveLog);
  const resolveReview = useSampleStore((s) => s.resolveReview);
  const batches = useBatchStore((s) => s.batches);
  const herbs = useHerbStore((s) => s.herbs);

  const [selectedCabinet, setSelectedCabinet] = useState<string | undefined>(undefined);
  const [showVoided, setShowVoided] = useState(false);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<SampleFormValues>();
  const [observeTarget, setObserveTarget] = useState<RetainSample | null>(null);
  const [observeForm] = Form.useForm<ObserveFormValues>();
  const [reviewTarget, setReviewTarget] = useState<RetainSample | null>(null);
  const [reviewAction, setReviewAction] = useState<SampleReviewAction>('沿用');
  const [reviewForm] = Form.useForm<ReviewFormValues>();

  const pendingSamples = useMemo(() => samples.filter((s) => s.reviewState === '待复核'), [samples]);
  const voidedSamples = useMemo(() => samples.filter((s) => s.reviewState === '已作废'), [samples]);
  const activeSamples = useMemo(() => samples.filter((s) => s.reviewState !== '已作废'), [samples]);

  const expiryListAll = useMemo(() => buildExpiryList(samples, 30), [samples]);
  const expiryList = useMemo(() => buildExpiryList(activeSamples, 30), [activeSamples]);
  const dueList = useMemo(() => expiryList.filter((item) => item.daysLeft <= 30), [expiryList]);
  const expired = useMemo(() => expiryList.filter((item) => item.daysLeft < 0), [expiryList]);
  const observing = useMemo(
    () => expiryList.filter((item) => item.daysLeft > 30 && item.sample.reviewState !== '待复核'),
    [expiryList],
  );

  /** 待复核置顶，其次按到期天数升序 */
  const visible = useMemo(() => {
    const list = selectedCabinet ? expiryListAll.filter((item) => item.sample.cabinet === selectedCabinet) : expiryListAll;
    const allowed = showVoided ? list : list.filter((item) => item.sample.reviewState !== '已作废');
    return allowed.sort((a, b) => {
      const rank = (s: RetainSample['reviewState']) => (s === '待复核' ? 0 : s === '已作废' ? 2 : 1);
      const ra = rank(a.sample.reviewState);
      const rb = rank(b.sample.reviewState);
      if (ra !== rb) return ra - rb;
      return a.daysLeft - b.daysLeft;
    });
  }, [expiryListAll, selectedCabinet, showVoided]);

  const batchOf = (batchId: string) => batches.find((b) => b.id === batchId);
  const batchLabel = (batchId: string) => {
    const batch = batchOf(batchId);
    if (!batch) return '未知批次';
    const herb = herbs.find((h) => h.id === batch.herbId);
    return `${batch.batchNo} · ${herb?.name ?? '未知药材'} · 当前 v${batch.currentVersion ?? '-'} ${batch.degree}`;
  };

  /** 留样判定依据版本标签 */
  const basisTag = (sample: RetainSample) => {
    const batch = batchOf(sample.batchId);
    const basis = batch ? basisDecision(batch, sample.basisVersion) : undefined;
    if (!batch || !basis) {
      return <Tag>未绑定版本</Tag>;
    }
    const stale = (sample.basisVersion ?? 0) < (batch.currentVersion ?? 0);
    return (
      <Space size={4}>
        <Tag color={stale ? 'orange' : 'blue'}>
          依据 v{basis.version} · {basis.degree}
        </Tag>
        {stale ? <Tag color="purple">批次已至 v{batch.currentVersion}</Tag> : null}
      </Space>
    );
  };

  const openCreate = () => {
    const lockedBatches = batches.filter((b) => b.locked && b.currentVersion);
    const nextIndex = samples.length + 1;
    const batch = lockedBatches[0];
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
    try {
      await createSample({
        sampleNo: values.sampleNo,
        batchId: values.batchId,
        amountG: values.amountG,
        retainMonths: values.retainMonths,
        cabinet: values.cabinet,
        retainedAt: values.retainedAt.toISOString(),
      });
      message.success(`已登记留样 ${values.sampleNo}，绑定该批当前判定版本`);
      setOpen(false);
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const openObserve = (record: RetainSample) => {
    if (record.reviewState === '待复核') {
      message.warning('该留样待质检复核：请先在「复核处理」中说明理由并沿用，再追加观察');
      return;
    }
    if (record.reviewState === '已作废') {
      message.warning('该留样已作废，不再追加观察');
      return;
    }
    setObserveTarget(record);
    observeForm.resetFields();
    observeForm.setFieldsValue({ date: dayjs(), color: '色泽符合标准', odor: '气味正常', mold: '无霉变', observer: '赵敏' } as unknown as ObserveFormValues);
  };

  const submitObserve = async () => {
    if (!observeTarget) return;
    const values = await observeForm.validateFields();
    try {
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
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const openReview = (record: RetainSample) => {
    setReviewTarget(record);
    setReviewAction('沿用');
    reviewForm.resetFields();
    reviewForm.setFieldsValue({
      action: '沿用',
      reason: '',
      qcBy: '质检员 · 赵敏',
      newSampleNo: `${record.sampleNo}-R${(record.reviewLogs?.length ?? 0) + 1}`,
      newAmountG: record.amountG,
      newRetainMonths: record.retainMonths,
      newCabinet: CABINETS.find((c) => !expiryList.some((item) => item.sample.cabinet === c)) ?? record.cabinet,
      newRetainedAt: dayjs(),
    } as unknown as ReviewFormValues);
  };

  const submitReview = async () => {
    if (!reviewTarget) return;
    const values = await reviewForm.validateFields();
    try {
      const result = await resolveReview(reviewTarget.id, {
        action: values.action,
        reason: values.reason,
        qcBy: values.qcBy,
        newSample:
          values.action === '重新取样'
            ? {
                sampleNo: values.newSampleNo ?? '',
                batchId: reviewTarget.batchId,
                amountG: values.newAmountG ?? 0,
                retainMonths: values.newRetainMonths ?? 12,
                cabinet: values.newCabinet ?? reviewTarget.cabinet,
                retainedAt: values.newRetainedAt?.toISOString(),
              }
            : undefined,
      });
      if (values.action === '重新取样') {
        message.success(`原留样已作废，新留样 ${result.newSample?.sampleNo ?? ''} 已绑定当前判定版本`);
      } else {
        message.success('已说明复核理由并沿用原留样，恢复观察中');
      }
      setReviewTarget(null);
    } catch (error) {
      message.error(`复核处置未写入：${(error as Error).message}（留样状态未改变）`);
    }
  };

  const reviewStateTag = (sample: RetainSample) => {
    if (sample.reviewState === '待复核') return <Tag color="red">待复核</Tag>;
    if (sample.reviewState === '已作废') return <Tag color="default">已作废</Tag>;
    return null;
  };

  const columns: TableColumnsType<SampleExpiry> = [
    {
      title: '留样编号',
      width: 180,
      render: (_, row) => (
        <Space size={4} direction="vertical" style={{ lineHeight: 1.2 }}>
          <Text strong delete={row.sample.reviewState === '已作废'}>
            {row.sample.sampleNo}
          </Text>
          {reviewStateTag(row.sample)}
        </Space>
      ),
    },
    { title: '关联批次', width: 260, render: (_, row) => batchLabel(row.sample.batchId) },
    {
      title: '判定依据',
      width: 200,
      render: (_, row) => basisTag(row.sample),
    },
    { title: '留样量(g)', width: 90, align: 'right', render: (_, row) => row.sample.amountG },
    { title: '留样期(月)', width: 90, align: 'right', render: (_, row) => row.sample.retainMonths },
    { title: '柜位', width: 80, render: (_, row) => <Tag color="green">{row.sample.cabinet}</Tag> },
    { title: '留样日期', width: 110, render: (_, row) => formatDate(row.sample.retainedAt) },
    {
      title: '到期日 / 剩余',
      width: 130,
      render: (_, row) =>
        row.sample.reviewState === '已作废' ? (
          <Text type="secondary">-</Text>
        ) : (
          <Space direction="vertical" size={0}>
            <Text>{row.expireAt}</Text>
            <Text type={row.daysLeft < 0 ? 'danger' : row.daysLeft <= 30 ? 'warning' : 'secondary'} style={{ fontSize: 12 }}>
              {row.daysLeft < 0 ? `过期 ${Math.abs(row.daysLeft)} 天` : `剩 ${row.daysLeft} 天`}
            </Text>
          </Space>
        ),
    },
    {
      title: '状态',
      width: 100,
      render: (_, row) =>
        row.sample.reviewState === '已作废' ? (
          <Tag>已作废</Tag>
        ) : row.sample.reviewState === '待复核' ? (
          <Tag color="red">待复核</Tag>
        ) : (
          <Tag color={STATE_COLOR[row.state]}>{row.state}</Tag>
        ),
    },
    { title: '观察记录', width: 90, align: 'right', render: (_, row) => `${row.sample.observeLogs.length} 条` },
    {
      title: '操作',
      width: 190,
      fixed: 'right',
      render: (_, row) => (
        <Space size={2}>
          {row.sample.reviewState === '待复核' ? (
            <Button size="small" type="link" danger onClick={() => openReview(row.sample)}>
              复核处理
            </Button>
          ) : (
            <Button size="small" type="link" disabled={row.sample.reviewState === '已作废'} onClick={() => openObserve(row.sample)}>
              追加观察
            </Button>
          )}
          <Popconfirm
            title={`确认删除留样 ${row.sample.sampleNo}？`}
            disabled={row.sample.reviewState === '待复核'}
            onConfirm={() =>
              removeSample(row.sample.id)
                .then(() => message.success('已删除'))
                .catch((error: Error) => message.error(error.message))
            }
          >
            <Button size="small" type="link" danger disabled={row.sample.reviewState === '待复核'}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
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

  const reviewTargetBatch = reviewTarget ? batchOf(reviewTarget.batchId) : undefined;
  const reviewBasis = reviewTargetBatch && reviewTarget ? basisDecision(reviewTargetBatch, reviewTarget.basisVersion) : undefined;
  const reviewCurrent = reviewTargetBatch ? currentDecision(reviewTargetBatch) : undefined;

  const lockedBatches = batches.filter((b) => b.locked && b.currentVersion);

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        留样与观察台账
      </Title>
      <Paragraph type="secondary">
        留样绑定建样时所依据的判定版本；批次复核改判程度转为太过时，关联留样先置为待复核，质检员说明理由后可沿用原留样继续观察或重新取样。
      </Paragraph>

      {pendingSamples.length > 0 ? (
        <Alert
          style={{ marginBottom: 16 }}
          type="error"
          showIcon
          message={`${pendingSamples.length} 份关联留样待质检复核（批次程度已改判为太过）`}
          description={
            <Space wrap>
              {pendingSamples.map((s) => (
                <Tag key={s.id} color="red">
                  {s.sampleNo}（依据 v{s.basisVersion ?? '-'}）
                </Tag>
              ))}
              <Text type="secondary">复核处理时须说明理由：沿用则恢复观察中；重新取样则旧留样作废，新留样绑定当前判定版本。</Text>
            </Space>
          }
        />
      ) : null}

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <StatBadge label="留样总数" value={samples.length - voidedSamples.length} unit="份" hint={voidedSamples.length ? `另有 ${voidedSamples.length} 份已作废` : undefined} />
        </Col>
        <Col xs={12} md={6}>
          <StatBadge label="观察中" value={observing.length} unit="份" status="success" />
        </Col>
        <Col xs={12} md={6}>
          <StatBadge label="待复核" value={pendingSamples.length} unit="份" status={pendingSamples.length ? 'error' : 'success'} />
        </Col>
        <Col xs={12} md={6}>
          <StatBadge label="30 天内到期" value={dueList.length} unit="份" status={dueList.length ? 'warning' : 'success'} hint={`其中已到期 ${expired.length} 份`} />
        </Col>
      </Row>

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

      <Space style={{ marginBottom: 8 }}>
        <Switch checked={showVoided} onChange={setShowVoided} checkedChildren="显示已作废留样" unCheckedChildren="隐藏已作废留样" />
      </Space>

      {visible.length === 0 ? (
        <EmptyPanel description={selectedCabinet ? `柜位 ${selectedCabinet} 暂无留样` : '暂无留样记录'} actionText="登记留样" onAction={openCreate} />
      ) : (
        <Table rowKey={(row) => row.sample.id} size="small" columns={columns} dataSource={visible} pagination={{ pageSize: 8 }} scroll={{ x: 1560 }} />
      )}

      <Modal open={open} title="登记留样" onCancel={() => setOpen(false)} onOk={submit} okText="保存" cancelText="取消" width={560}>
        {lockedBatches.length === 0 ? (
          <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="暂无已锁定批次：留样须绑定判定版本，请先在工序记录台锁定批次" />
        ) : null}
        <Form form={form} layout="vertical">
          <Form.Item name="sampleNo" label="留样编号" rules={[{ required: true, message: '请输入留样编号' }]}>
            <Input maxLength={32} />
          </Form.Item>
          <Form.Item name="batchId" label="关联炮制批次（仅限已锁定，留样绑定其当前判定版本）" rules={[{ required: true, message: '请选择关联批次' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={lockedBatches.map((b) => ({ label: batchLabel(b.id), value: b.id }))}
            />
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
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={
              <Space wrap>
                {basisTag(observeTarget)}
                <Text type="secondary">留样日期 {formatDate(observeTarget.retainedAt)}</Text>
              </Space>
            }
          />
        ) : null}
        {observeTarget?.reviewLogs?.length ? (
          <Card size="small" style={{ marginBottom: 12 }} title="复核处置留痕">
            <Timeline
              items={observeTarget.reviewLogs.map((log) => ({
                color: log.action === '重新取样' ? 'red' : 'green',
                children: (
                  <div>
                    <Tag color={log.action === '重新取样' ? 'red' : 'green'}>{log.action}</Tag>
                    <Text type="secondary">{formatDateTime(log.reviewedAt)} · {log.qcBy}</Text>
                    <div>{log.reason}</div>
                    {log.newSampleNo ? <div>新留样：<Text strong>{log.newSampleNo}</Text></div> : null}
                  </div>
                ),
              }))}
            />
          </Card>
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
        onOk={submitReview}
        okText={reviewAction === '重新取样' ? '确认作废并重新取样' : '确认沿用原留样'}
        cancelText="取消"
        width={640}
        okButtonProps={{ danger: reviewAction === '重新取样' }}
      >
        {reviewTarget ? (
          <>
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              message="该关联留样待复核"
              description={reviewTarget.pendingReason ?? '批次复核改判程度转为太过，关联留样先待复核'}
            />
            <Card size="small" style={{ marginBottom: 12 }}>
              <Space direction="vertical" size={4}>
                <Text>留样编号：<Text strong>{reviewTarget.sampleNo}</Text> · 柜位 {reviewTarget.cabinet} · 留样量 {reviewTarget.amountG}g</Text>
                <Space wrap>
                  <Text>留样依据：</Text>
                  {reviewBasis ? (
                    <Tag color="orange">v{reviewBasis.version} {reviewBasis.degree} · 得率 {reviewBasis.yieldRate}%</Tag>
                  ) : (
                    <Tag>未知版本</Tag>
                  )}
                  <Text type="secondary">→</Text>
                  <Text>批次当前判定：</Text>
                  {reviewCurrent ? (
                    <Tag color="red">v{reviewCurrent.version} {reviewCurrent.degree} · 得率 {reviewCurrent.yieldRate}%</Tag>
                  ) : null}
                </Space>
                {reviewCurrent?.reason ? <Text type="secondary">改判原因：{reviewCurrent.reason}</Text> : null}
              </Space>
            </Card>

            <Form form={reviewForm} layout="vertical" initialValues={{ action: '沿用' }}>
              <Form.Item name="action" label="处置方式" rules={[{ required: true }]}>
                <Radio.Group
                  onChange={(e) => setReviewAction(e.target.value as SampleReviewAction)}
                  options={[
                    { label: '沿用原留样：说明理由后恢复观察中，继续按原留样台账观察', value: '沿用' },
                    { label: '重新取样：原留样作废，新留样绑定当前判定版本', value: '重新取样' },
                  ]}
                />
              </Form.Item>

              <Space size={12} style={{ display: 'flex' }} align="start">
                <Form.Item
                  name="reason"
                  label="质检复核理由说明（必填）"
                  rules={[{ required: true, message: '请说明沿用或重新取样的理由' }]}
                  style={{ flex: 1 }}
                >
                  <Input.TextArea rows={3} maxLength={120} showCount placeholder="如：复核留样外观气味稳定，判定太过仅影响成品放行，留样可继续观察" />
                </Form.Item>
                <Form.Item name="qcBy" label="复核人" rules={[{ required: true, message: '请填写复核人' }]} style={{ width: 160 }}>
                  <Input maxLength={16} />
                </Form.Item>
              </Space>

              {reviewAction === '重新取样' ? (
                <Card size="small" type="inner" title="新留样登记（绑定当前判定版本）" style={{ marginBottom: 12 }}>
                  <Space size={12} style={{ display: 'flex' }} align="start">
                    <Form.Item name="newSampleNo" label="新留样编号" rules={[{ required: true, message: '请输入新留样编号' }]}>
                      <Input maxLength={32} style={{ width: 180 }} />
                    </Form.Item>
                    <Form.Item name="newAmountG" label="留样量(g)" rules={[{ required: true, message: '请输入留样量' }]}>
                      <InputNumber min={0} style={{ width: 120 }} />
                    </Form.Item>
                    <Form.Item name="newRetainMonths" label="留样期(月)" rules={[{ required: true, message: '请选择留样期' }]}>
                      <Select style={{ width: 120 }} options={[3, 6, 12, 18, 24, 36].map((m) => ({ label: `${m} 个月`, value: m }))} />
                    </Form.Item>
                  </Space>
                  <Space size={12} style={{ display: 'flex' }} align="start">
                    <Form.Item name="newCabinet" label="新柜位" rules={[{ required: true, message: '请选择柜位' }]}>
                      <Select style={{ width: 140 }} showSearch options={CABINETS.map((c) => ({ label: c, value: c }))} />
                    </Form.Item>
                    <Form.Item name="newRetainedAt" label="取样日期" rules={[{ required: true, message: '请选择取样日期' }]}>
                      <DatePicker style={{ width: 180 }} />
                    </Form.Item>
                  </Space>
                </Card>
              ) : null}
            </Form>

            {reviewTarget.reviewLogs?.length ? (
              <Card size="small" title="历史复核处置">
                <Timeline
                  items={reviewTarget.reviewLogs.map((log) => ({
                    color: log.action === '重新取样' ? 'red' : 'green',
                    children: (
                      <div>
                        <Tag color={log.action === '重新取样' ? 'red' : 'green'}>{log.action}</Tag>
                        <Text type="secondary">{formatDateTime(log.reviewedAt)} · {log.qcBy}</Text>
                        <div>{log.reason}</div>
                      </div>
                    ),
                  }))}
                />
              </Card>
            ) : null}
          </>
        ) : null}
      </Modal>
    </div>
  );
}
