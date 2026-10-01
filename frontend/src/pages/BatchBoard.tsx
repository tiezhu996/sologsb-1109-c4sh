import { useMemo, useState } from 'react';
import { Alert, App as AntApp, Button, Card, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useSearchParams } from 'react-router-dom';
import FilterBar from '../components/common/FilterBar';
import FireLevelTag from '../components/common/FireLevelTag';
import RatioCalculator from '../components/common/RatioCalculator';
import EmptyPanel from '../components/common/EmptyPanel';
import { useHerbFilter } from '../hooks/useHerbFilter';
import { useHerbStore } from '../stores/herbStore';
import { useMethodStore } from '../stores/methodStore';
import { useBatchStore } from '../stores/batchStore';
import { useSampleStore } from '../stores/sampleStore';
import { HERB_ORIGINS, HERB_PARTS } from '../types/herb-material';
import { FIRE_LEVELS, type FireLevel } from '../types/processing-method';
import { PROCESS_DEGREES, type BatchDecision, type ProcessBatch, type ProcessDegree } from '../types/process-batch';
import { DEGREE_RULES, judgeDegree, suggestedValues } from '../utils/degree';

const { Title, Paragraph, Text } = Typography;

interface BatchFormValues {
  batchNo: string;
  herbId: string;
  methodId: string;
  feedKg: number;
  auxUsedKg: number;
  outputKg: number;
  fireLevel: FireLevel;
  temp: number;
  duration: number;
  startedAt: Dayjs;
  endedAt: Dayjs;
  operator: string;
  degree: ProcessDegree;
  remark?: string;
  /** 改判理由（质检员改判时必填，写入新版本流水） */
  rejudgeReason?: string;
  /** 改判质检员 */
  qcName?: string;
}

const DEGREE_COLOR: Record<ProcessDegree, string> = { 不及: 'orange', 适中: 'green', 太过: 'red' };

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 工序记录台：选方法自动带出辅料比例、火候与判断标准，录入火候与得率 */
export default function BatchBoard() {
  const { message } = AntApp.useApp();
  const herbs = useHerbStore((s) => s.herbs);
  const methods = useMethodStore((s) => s.methods);
  const batches = useBatchStore((s) => s.batches);
  const createBatch = useBatchStore((s) => s.createBatch);
  const updateBatch = useBatchStore((s) => s.updateBatch);
  const lockBatch = useBatchStore((s) => s.lockBatch);
  const rejudgeBatch = useBatchStore((s) => s.rejudgeBatch);
  const unlockAsQc = useBatchStore((s) => s.unlockAsQc);
  const removeBatch = useBatchStore((s) => s.removeBatch);
  const samples = useSampleStore((s) => s.samples);

  const herbFilter = useHerbFilter();
  const [params] = useSearchParams();
  const degreeParam = params.get('degree') ?? '';

  const [form] = Form.useForm<BatchFormValues>();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ProcessBatch | null>(null);
  /** 已锁定批次的质检员改判开关 */
  const [qcMode, setQcMode] = useState(false);
  const [showRules, setShowRules] = useState(false);

  const watched = Form.useWatch([], form) as Partial<BatchFormValues> | undefined;
  const watchedMethod = methods.find((m) => m.id === (watched?.methodId ?? ''));
  const watchedYieldRate = useMemo(() => {
    const feed = Number(watched?.feedKg) || 0;
    const out = Number(watched?.outputKg) || 0;
    if (feed <= 0) return 0;
    return Number(((out / feed) * 100).toFixed(1));
  }, [watched?.feedKg, watched?.outputKg]);

  const verdict = useMemo(() => {
    if (!watchedMethod) return undefined;
    return judgeDegree({
      method: watchedMethod,
      fireLevel: (watched?.fireLevel ?? watchedMethod.fireLevel) as FireLevel,
      duration: Number(watched?.duration) || watchedMethod.duration,
      temp: Number(watched?.temp) || Math.round((watchedMethod.tempRange[0] + watchedMethod.tempRange[1]) / 2),
      yieldRate: watchedYieldRate,
    });
  }, [watchedMethod, watched?.fireLevel, watched?.duration, watched?.temp, watchedYieldRate]);

  const visibleHerbs = useMemo(() => herbFilter.apply(herbs), [herbs, herbFilter]);
  const visibleBatches = useMemo(() => {
    const ids = new Set(visibleHerbs.map((h) => h.id));
    return batches.filter((b) => {
      if (!ids.has(b.herbId)) return false;
      if (degreeParam && b.degree !== degreeParam) return false;
      return true;
    });
  }, [batches, visibleHerbs, degreeParam]);

  /** 弹窗当前正在改判的锁定批次（编辑对象 + 质检开关同时满足） */
  const rejudging = Boolean(editing?.locked) && qcMode;
  /** 弹窗处于只读或改判态时，批号/药材等工序身份字段不可动 */
  const identityLocked = Boolean(editing?.locked);

  const herbName = (id: string) => herbs.find((h) => h.id === id)?.name ?? '未知药材';
  const methodOf = (id: string) => methods.find((m) => m.id === id);
  const heldCountOf = (batchId: string) =>
    samples.filter((s) => s.batchId === batchId && s.reviewState === '待复核').length;

  const openCreate = () => {
    setEditing(null);
    setQcMode(false);
    form.resetFields();
    const firstHerb = herbs[0];
    const firstMethod = methods[0];
    const now = dayjs();
    const base: Partial<BatchFormValues> = {
      batchNo: `PZ-${dayjs().format('YYMMDD')}-${String(batches.length + 1).padStart(2, '0')}`,
      herbId: firstHerb?.id,
      methodId: firstMethod?.id,
      feedKg: firstHerb?.feedKg ?? 100,
      outputKg: Number((((firstHerb?.feedKg ?? 100) * 0.94)).toFixed(1)),
      auxUsedKg: Number((((firstHerb?.feedKg ?? 100) * (firstMethod?.auxRatio ?? 0)) / 100).toFixed(2)),
      fireLevel: firstMethod?.fireLevel ?? '文火',
      temp: firstMethod ? Math.round((firstMethod.tempRange[0] + firstMethod.tempRange[1]) / 2) : 100,
      duration: firstMethod?.duration ?? 12,
      startedAt: now.subtract(20, 'minute'),
      endedAt: now,
      operator: '陈玉兰',
      degree: '适中',
      qcName: '质检员 · 赵敏',
    };
    form.setFieldsValue(base as unknown as BatchFormValues);
    setOpen(true);
  };

  const openEdit = (record: ProcessBatch) => {
    setEditing(record);
    setQcMode(false);
    form.resetFields();
    const suggested = methodOf(record.methodId);
    form.setFieldsValue({
      batchNo: record.batchNo,
      herbId: record.herbId,
      methodId: record.methodId,
      feedKg: record.feedKg,
      auxUsedKg: record.auxUsedKg,
      outputKg: Number(((record.feedKg * record.yieldRate) / 100).toFixed(1)),
      fireLevel: record.fireLevel,
      temp: record.temp ?? (suggested ? Math.round((suggested.tempRange[0] + suggested.tempRange[1]) / 2) : 100),
      duration: record.duration ?? suggested?.duration ?? 12,
      startedAt: dayjs(record.startedAt),
      endedAt: dayjs(record.endedAt),
      operator: record.operator,
      degree: record.degree,
      remark: record.remark,
      qcName: '质检员 · 赵敏',
    } as unknown as BatchFormValues);
    setOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    const outputKg = Number(values.outputKg) || 0;
    const feedKg = Number(values.feedKg) || 0;
    if (feedKg <= 0) {
      message.error('投料量必须大于 0');
      return;
    }
    const yieldRate = Number(((outputKg / feedKg) * 100).toFixed(1));

    if (editing) {
      if (editing.locked) {
        if (!qcMode) {
          message.error('该批已锁定，请打开「质检员改判」开关后按复核版本提交');
          return;
        }
        // 已锁定批次：追加复核版本，旧程度/得率/方法与原因全部保留在版本流水里
        try {
          const result = await rejudgeBatch(editing.id, {
            degree: values.degree,
            yieldRate,
            methodId: values.methodId,
            fireLevel: values.fireLevel,
            temp: Number(values.temp) || undefined,
            duration: Number(values.duration) || undefined,
            reason: values.rejudgeReason ?? '',
            qcBy: values.qcName?.trim() || '质检员 · 赵敏',
          });
          if (!result) {
            message.error('批次不存在或已被删除');
            return;
          }
          if (result.heldSamples.length > 0) {
            message.warning(`已生成 v${result.batch.currentVersion} 改判版本；程度转为太过，${result.heldSamples.length} 份关联留样已置为待复核`);
          } else {
            message.success(`已生成 v${result.batch.currentVersion} 改判版本，旧版本保留可查`);
          }
        } catch (error) {
          message.error(`改判未写入：${(error as Error).message}（原复核版本与留样状态均未改变）`);
          return;
        }
      } else {
        const ok = await updateBatch(editing.id, {
          batchNo: values.batchNo,
          herbId: values.herbId,
          methodId: values.methodId,
          feedKg,
          auxUsedKg: Number(values.auxUsedKg) || 0,
          fireLevel: values.fireLevel,
          temp: Number(values.temp) || undefined,
          duration: Number(values.duration) || undefined,
          startedAt: values.startedAt.toISOString(),
          endedAt: values.endedAt.toISOString(),
          yieldRate,
          degree: values.degree,
          operator: values.operator,
          remark: values.remark,
        });
        if (!ok) {
          message.error('该批已锁定，改判需由质检员追加复核版本');
          return;
        }
        message.success(`已更新 ${values.batchNo}，得率 ${yieldRate}%`);
      }
    } else {
      await createBatch(
        {
          batchNo: values.batchNo,
          herbId: values.herbId,
          methodId: values.methodId,
          feedKg,
          auxUsedKg: Number(values.auxUsedKg) || 0,
          fireLevel: values.fireLevel,
          temp: Number(values.temp) || undefined,
          duration: Number(values.duration) || undefined,
          startedAt: values.startedAt.toISOString(),
          endedAt: values.endedAt.toISOString(),
          yieldRate,
          degree: values.degree,
          operator: values.operator,
          remark: values.remark,
        },
        true,
      );
      message.success(`已提交 ${values.batchNo}，得率 ${yieldRate}%，该批已锁定并生成 v1 初判版本`);
    }
    setOpen(false);
  };

  const handleLock = async (record: ProcessBatch) => {
    try {
      const result = await lockBatch(record.id);
      if (!result) {
        message.error('批次不存在或已被删除');
        return;
      }
      if (result.heldSamples.length > 0) {
        message.warning(`已锁定并生成判定版本，${result.heldSamples.length} 份关联留样已置为待复核`);
      } else {
        message.success('已锁定该批并生成判定版本');
      }
    } catch (error) {
      message.error(`锁定失败：${(error as Error).message}`);
    }
  };

  const decisionColumns: TableColumnsType<BatchDecision> = [
    { title: '版本', width: 70, render: (_, d) => <Tag color={d.kind === '初判' ? 'blue' : 'purple'}>v{d.version} {d.kind}</Tag> },
    { title: '程度', width: 80, render: (_, d) => <Tag color={DEGREE_COLOR[d.degree]}>{d.degree}</Tag> },
    { title: '得率(%)', dataIndex: 'yieldRate', width: 90, align: 'right' },
    { title: '方法', width: 90, render: (_, d) => methodOf(d.methodId)?.name ?? '-' },
    { title: '火候', dataIndex: 'fireLevel', width: 80 },
    { title: '锅温(℃)', width: 80, align: 'right', render: (_, d) => d.temp ?? '-' },
    { title: '时长(min)', width: 90, align: 'right', render: (_, d) => d.duration ?? '-' },
    { title: '判定人', dataIndex: 'qcBy', width: 110 },
    { title: '时间', width: 140, render: (_, d) => formatDateTime(d.decidedAt) },
    { title: '判定理由/改判原因', dataIndex: 'reason' },
  ];

  const columns: TableColumnsType<ProcessBatch> = [
    { title: '生产批号', dataIndex: 'batchNo', width: 130, render: (v: string) => <Text strong>{v}</Text> },
    { title: '药材', dataIndex: 'herbId', width: 90, render: (id: string) => herbName(id) },
    { title: '方法', dataIndex: 'methodId', width: 90, render: (id: string) => methodOf(id)?.name ?? '-' },
    {
      title: '火候',
      dataIndex: 'fireLevel',
      width: 180,
      render: (v: FireLevel, record) => <FireLevelTag level={v} tempRange={methodOf(record.methodId)?.tempRange} duration={methodOf(record.methodId)?.duration} />,
    },
    { title: '投料(kg)', dataIndex: 'feedKg', width: 90, align: 'right' },
    { title: '辅料(kg)', dataIndex: 'auxUsedKg', width: 90, align: 'right' },
    { title: '得率(%)', dataIndex: 'yieldRate', width: 90, align: 'right', render: (v: number) => <Text type={v < 85 ? 'danger' : undefined}>{v}</Text> },
    {
      title: '程度/版本',
      dataIndex: 'degree',
      width: 120,
      render: (v: ProcessDegree, record) => (
        <Space size={4} direction="vertical" style={{ lineHeight: 1.2 }}>
          <Tag color={DEGREE_COLOR[v]}>{v}</Tag>
          {record.currentVersion ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              v{record.currentVersion}
              {(record.decisions?.length ?? 0) > 1 ? ` / 共 ${record.decisions?.length} 版` : ''}
            </Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'locked',
      width: 130,
      render: (locked: boolean, record) => {
        const held = heldCountOf(record.id);
        return (
          <Space size={4} direction="vertical" style={{ lineHeight: 1.2 }}>
            {locked ? <Tag color="blue">已锁定{record.qcBy ? ` · ${record.qcBy}` : ''}</Tag> : <Tag>待判定</Tag>}
            {held > 0 ? <Tag color="red">{held} 份留样待复核</Tag> : null}
          </Space>
        );
      },
    },
    { title: '操作人', dataIndex: 'operator', width: 90 },
    {
      title: '操作',
      width: 230,
      fixed: 'right',
      render: (_, record) => (
        <Space size={2}>
          <Button size="small" type="link" onClick={() => openEdit(record)}>
            {record.locked ? '质检改判' : '编辑'}
          </Button>
          {!record.locked ? (
            <Button size="small" type="link" onClick={() => handleLock(record)}>
              锁定
            </Button>
          ) : (
            <Button size="small" type="link" onClick={() => unlockAsQc(record.id, '质检员 · 赵敏').then(() => message.success('质检员已放行，可重新编辑；重锁将作为改判版本留痕'))}>
              放行
            </Button>
          )}
          <Popconfirm title={`确认删除 ${record.batchNo}？`} onConfirm={() => removeBatch(record.id).then(() => message.success('已删除'))}>
            <Button size="small" type="link" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  /** 改判前后差异提示（程度/得率/方法/火候） */
  const prevDecision = editing?.decisions?.[editing.decisions.length - 1];
  const nextDegree: ProcessDegree | undefined = watched?.degree;
  const diffItems = rejudging && prevDecision
    ? [
        {
          label: '程度',
          prev: <Tag color={DEGREE_COLOR[prevDecision.degree]}>{prevDecision.degree}</Tag>,
          next: <Tag color={DEGREE_COLOR[nextDegree ?? prevDecision.degree]}>{nextDegree ?? '-'}</Tag>,
        },
        { label: '得率', prev: `${prevDecision.yieldRate}%`, next: `${watchedYieldRate}%` },
        { label: '方法', prev: methodOf(prevDecision.methodId)?.name ?? '-', next: watchedMethod?.name ?? '-' },
        { label: '火候', prev: prevDecision.fireLevel, next: watched?.fireLevel ?? '-' },
        { label: '锅温', prev: prevDecision.temp !== undefined ? `${prevDecision.temp}℃` : '-', next: watched?.temp !== undefined ? `${watched.temp}℃` : '-' },
        { label: '时长', prev: prevDecision.duration !== undefined ? `${prevDecision.duration}min` : '-', next: watched?.duration !== undefined ? `${watched.duration}min` : '-' },
      ]
    : [];

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        炮制工序记录台
      </Title>
      <Paragraph type="secondary">
        选择方法即带出辅料比例、火候与判断标准；录入实际锅温、时长与炮制后重量，系统按标准自动给出程度判定，提交后锁定该批。质检改判以复核版本追加，旧程度、得率、方法与原因全程留痕。
      </Paragraph>

      <Space style={{ marginBottom: 12 }} wrap>
        <Button type="primary" onClick={openCreate}>
          新建工序记录
        </Button>
        <Button onClick={() => setShowRules((v) => !v)}>{showRules ? '收起程度判定规则' : '查看程度判定规则'}</Button>
      </Space>

      {showRules ? (
        <Card size="small" style={{ marginBottom: 12 }} title="炮制程度判定规则">
          <Table
            rowKey="degree"
            size="small"
            pagination={false}
            dataSource={DEGREE_RULES}
            columns={[
              { title: '程度', dataIndex: 'degree', width: 90, render: (v: ProcessDegree) => <Tag color={DEGREE_COLOR[v]}>{v}</Tag> },
              { title: '判定条件', dataIndex: 'condition' },
              { title: '处置', dataIndex: 'action', width: 280 },
            ]}
          />
        </Card>
      ) : null}

      <FilterBar
        fields={[
          { key: 'origin', label: '基原', options: HERB_ORIGINS, width: 110 },
          { key: 'part', label: '药用部位', options: HERB_PARTS, width: 110 },
          { key: 'degree', label: '程度', options: PROCESS_DEGREES, width: 110 },
        ]}
        resultCount={visibleBatches.length}
        totalCount={batches.length}
        keywordPlaceholder="搜索药材名 / 批号"
      />

      {visibleBatches.length === 0 ? (
        <EmptyPanel description="没有符合条件的工序记录" actionText="新建一条工序记录" onAction={openCreate} />
      ) : (
        <Table rowKey="id" size="small" columns={columns} dataSource={visibleBatches} pagination={{ pageSize: 10 }} scroll={{ x: 1500 }} />
      )}

      <Modal
        open={open}
        title={editing ? `工序记录 · ${editing.batchNo}` : '新建炮制工序记录'}
        onCancel={() => setOpen(false)}
        onOk={submit}
        okText={rejudging ? '提交改判新版本' : editing ? '保存' : '提交并锁定该批'}
        cancelText="取消"
        width={820}
      >
        <Form
          form={form}
          layout="vertical"
          onValuesChange={(changed) => {
            if ('methodId' in changed) {
              const method = methods.find((m) => m.id === changed.methodId);
              if (method) {
                const suggestion = suggestedValues(method);
                const feed = Number(form.getFieldValue('feedKg')) || 0;
                form.setFieldsValue({
                  fireLevel: method.fireLevel,
                  temp: suggestion.temp,
                  duration: suggestion.duration,
                  auxUsedKg: Number(((feed * method.auxRatio) / 100).toFixed(2)),
                } as unknown as BatchFormValues);
              }
            }
            if ('feedKg' in changed) {
              const method = methods.find((m) => m.id === form.getFieldValue('methodId'));
              if (method) {
                const feed = Number(changed.feedKg) || 0;
                form.setFieldsValue({
                  auxUsedKg: Number(((feed * method.auxRatio) / 100).toFixed(2)),
                  outputKg: Number((feed * (method.name === '蜜炙' ? 1.08 : 0.94)).toFixed(1)),
                } as unknown as BatchFormValues);
              }
            }
            if (verdict && ('temp' in changed || 'duration' in changed || 'outputKg' in changed)) {
              form.setFieldsValue({ degree: verdict.degree } as unknown as BatchFormValues);
            }
          }}
        >
          {editing?.locked ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message={
                qcMode
                  ? '质检员改判中：保存将追加复核版本（旧程度、得率、方法与原因保留），批次仍保持锁定'
                  : '该批得率与程度已锁定；改判以复核版本追加，不覆盖旧结论'
              }
              description={
                qcMode
                  ? '若改判程度转为太过，关联留样将先置为「待复核」，由质检员说明理由后沿用或重新取样。'
                  : '打开开关后可调整程度、得率（炮制后重量）、方法与火候，并必须填写改判原因。'
              }
              action={<Switch checkedChildren="质检员改判" unCheckedChildren="只读" checked={qcMode} onChange={setQcMode} />}
            />
          ) : null}

          {editing?.decisions && editing.decisions.length > 0 ? (
            <Card
              size="small"
              style={{ marginBottom: 12 }}
              title={`判定版本流水（当前生效 v${editing.currentVersion}）`}
              extra={<Text type="secondary">留样绑定其建样时所依据的版本</Text>}
            >
              <Table
                rowKey="version"
                size="small"
                pagination={false}
                dataSource={[...editing.decisions].reverse()}
                columns={decisionColumns}
                scroll={{ x: 720 }}
              />
            </Card>
          ) : null}

          {rejudging && diffItems.length > 0 ? (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              message="改判前后对比"
              description={
                <Space size={24} wrap>
                  {diffItems.map((item) => (
                    <span key={item.label}>
                      <Text type="secondary">{item.label}：</Text>
                      {item.prev}
                      <Text type="secondary"> → </Text>
                      {item.next}
                    </span>
                  ))}
                </Space>
              }
            />
          ) : null}

          <Form.Item name="batchNo" label="生产批号" rules={[{ required: true, message: '请输入生产批号' }]}>
            <Input maxLength={24} disabled={identityLocked} />
          </Form.Item>

          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="herbId" label="药材" rules={[{ required: true, message: '请选择药材' }]} style={{ flex: 1 }}>
              <Select
                showSearch
                optionFilterProp="label"
                disabled={identityLocked}
                options={herbs.map((h) => ({ label: `${h.name} · ${h.batchNo}（${h.feedKg}kg）`, value: h.id }))}
              />
            </Form.Item>
            <Form.Item
              name="methodId"
              label="炮制方法（改判可调整并留痕）"
              rules={[{ required: true, message: '请选择炮制方法' }]}
              style={{ flex: 1 }}
            >
              <Select
                disabled={identityLocked && !qcMode}
                options={methods.map((m) => ({ label: `${m.name} · ${m.auxiliary} ${m.auxRatio}kg/100kg`, value: m.id }))}
              />
            </Form.Item>
          </Space>

          {watchedMethod ? (
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 12 }}
              message={
                <Space wrap size={8}>
                  <span>辅料比例 {watchedMethod.auxRatio}kg/100kg</span>
                  <FireLevelTag level={watchedMethod.fireLevel} tempRange={watchedMethod.tempRange} duration={watchedMethod.duration} />
                  <Tag>{watchedMethod.criterionDimension}</Tag>
                </Space>
              }
              description={`判断标准：${watchedMethod.criterion}；适用药材：${watchedMethod.applicable}`}
            />
          ) : null}

          <RatioCalculator
            auxRatio={watchedMethod?.auxRatio ?? 0}
            auxiliary={watchedMethod?.auxiliary ?? '无'}
            feedKg={Number(watched?.feedKg) || 0}
            auxUsedKg={Number(watched?.auxUsedKg) || 0}
            outputKg={Number(watched?.outputKg) || 0}
            onChange={(patch) => {
              if (patch.feedKg !== undefined) {
                form.setFieldsValue({ feedKg: patch.feedKg } as unknown as BatchFormValues);
              }
              if (patch.auxUsedKg !== undefined) {
                form.setFieldsValue({ auxUsedKg: patch.auxUsedKg } as unknown as BatchFormValues);
              }
            }}
          />

          <Space size={12} style={{ display: 'flex', marginTop: 12 }} align="start">
            <Form.Item name="fireLevel" label="火力（改判可调整）" rules={[{ required: true, message: '请选择火力' }]}>
              <Select style={{ width: 120 }} disabled={identityLocked && !qcMode} options={FIRE_LEVELS.map((v) => ({ label: v, value: v }))} />
            </Form.Item>
            <Form.Item name="temp" label="实际锅温(℃)" rules={[{ required: true, message: '请输入实际锅温' }]}>
              <InputNumber min={0} max={800} style={{ width: 140 }} disabled={identityLocked && !qcMode} />
            </Form.Item>
            <Form.Item name="duration" label="炮制时长(min)" rules={[{ required: true, message: '请输入炮制时长' }]}>
              <InputNumber min={0} style={{ width: 140 }} disabled={identityLocked && !qcMode} />
            </Form.Item>
            <Form.Item
              name="outputKg"
              label="炮制后重量(kg)（改判改得率）"
              rules={[{ required: true, message: '请输入炮制后重量' }]}
            >
              <InputNumber min={0} step={0.5} style={{ width: 190 }} disabled={identityLocked && !qcMode} />
            </Form.Item>
          </Space>

          <Form.Item name="feedKg" label="投料量(kg)" rules={[{ required: true, message: '请输入投料量' }]} style={{ maxWidth: 200 }}>
            <InputNumber min={0} step={1} style={{ width: '100%' }} disabled={identityLocked && !qcMode} />
          </Form.Item>

          <Alert
            type={verdict?.degree === '适中' ? 'success' : verdict?.degree === '太过' ? 'error' : 'warning'}
            showIcon
            style={{ marginBottom: 12 }}
            message={`系统判定：${verdict?.degree ?? '待录入火候与得率'}（得率 ${watchedYieldRate}%，预期 ${verdict?.expectedYield ?? '-'}%）`}
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {(verdict?.reasons ?? ['选择方法并录入锅温、时长、炮制后重量后自动判定']).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            }
          />

          <Form.Item name="degree" label="程度判定（改判以新版本保存，旧程度可在流水里查）" rules={[{ required: true, message: '请选择程度' }]}>
            <Select disabled={identityLocked && !qcMode} options={PROCESS_DEGREES.map((v) => ({ label: v, value: v }))} />
          </Form.Item>

          {rejudging ? (
            <>
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message={`改判前：${prevDecision?.degree ?? '-'} · 得率 ${prevDecision?.yieldRate ?? '-'}% · ${methodOf(prevDecision?.methodId ?? '')?.name ?? '-'} · ${prevDecision?.fireLevel ?? '-'}（v${prevDecision?.version ?? '-'}）`}
              />
              <Space size={12} style={{ display: 'flex' }} align="start">
                <Form.Item
                  name="rejudgeReason"
                  label="改判原因（必填，随复核版本留痕）"
                  rules={[{ required: true, message: '请填写改判原因' }]}
                  style={{ flex: 1 }}
                >
                  <Input.TextArea rows={2} maxLength={120} showCount placeholder="如：复查断面偏深、口尝焦苦，得率低于预期 6% 以上" />
                </Form.Item>
                <Form.Item name="qcName" label="质检员" rules={[{ required: true, message: '请填写质检员' }]} style={{ width: 160 }}>
                  <Input maxLength={16} />
                </Form.Item>
              </Space>
            </>
          ) : null}

          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="startedAt" label="开始时间" rules={[{ required: true, message: '请选择开始时间' }]}>
              <DatePicker showTime style={{ width: 190 }} disabled={identityLocked} />
            </Form.Item>
            <Form.Item name="endedAt" label="结束时间" rules={[{ required: true, message: '请选择结束时间' }]}>
              <DatePicker showTime style={{ width: 190 }} disabled={identityLocked} />
            </Form.Item>
            <Form.Item name="operator" label="操作人" rules={[{ required: true, message: '请输入操作人' }]}>
              <Input style={{ width: 140 }} maxLength={16} disabled={identityLocked} />
            </Form.Item>
          </Space>

          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={80} disabled={identityLocked} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
