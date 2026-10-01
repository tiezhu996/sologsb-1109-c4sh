import { useMemo, useState } from 'react';
import { Alert, App as AntApp, Button, Card, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Timeline, Typography } from 'antd';
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
import { HERB_ORIGINS, HERB_PARTS } from '../types/herb-material';
import { FIRE_LEVELS, type FireLevel } from '../types/processing-method';
import { PROCESS_DEGREES, type BatchReview, type ProcessBatch, type ProcessDegree } from '../types/process-batch';
import { DEGREE_RULES, judgeDegree, suggestedValues, formatDate } from '../utils/degree';
import { latestReview } from '../utils/review';

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
  /** 质检员复核改判原因（仅改判时必填） */
  reviewReason?: string;
  qcBy?: string;
}

const DEGREE_COLOR: Record<ProcessDegree, string> = { 不及: 'orange', 适中: 'green', 太过: 'red' };

/** 工序记录台：选方法自动带出辅料比例、火候与判断标准，录入火候与得率 */
export default function BatchBoard() {
  const { message } = AntApp.useApp();
  const herbs = useHerbStore((s) => s.herbs);
  const methods = useMethodStore((s) => s.methods);
  const batches = useBatchStore((s) => s.batches);
  const createBatch = useBatchStore((s) => s.createBatch);
  const updateBatch = useBatchStore((s) => s.updateBatch);
  const lockBatch = useBatchStore((s) => s.lockBatch);
  const unlockAsQc = useBatchStore((s) => s.unlockAsQc);
  const reviewAsQc = useBatchStore((s) => s.reviewAsQc);
  const removeBatch = useBatchStore((s) => s.removeBatch);

  const herbFilter = useHerbFilter();
  const [params] = useSearchParams();
  const degreeParam = params.get('degree') ?? '';

  const [form] = Form.useForm<BatchFormValues>();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ProcessBatch | null>(null);
  const [qcMode, setQcMode] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [historyTarget, setHistoryTarget] = useState<ProcessBatch | null>(null);

  const watched = Form.useWatch([], form) as Partial<BatchFormValues> | undefined;
  const watchedMethod = methods.find((m) => m.id === (watched?.methodId ?? ''));
  const watchedYieldRate = useMemo(() => {
    const feed = Number(watched?.feedKg) || 0;
    const out = Number(watched?.outputKg) || 0;
    if (feed <= 0) return 0;
    return Number(((out / feed) * 100).toFixed(1));
  }, [watched?.feedKg, watched?.outputKg]);

  /** 改判时基于表单值重新计算系统判定，仅作提示，不强制覆盖 */
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

  const herbName = (id: string) => herbs.find((h) => h.id === id)?.name ?? '未知药材';
  const methodOf = (id: string) => methods.find((m) => m.id === id);

  /** 已锁定批次的改判：只允许改判判定相关字段 */
  const isRejudge = Boolean(editing?.locked && qcMode);
  const previousReview = editing ? latestReview(editing) : undefined;

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
      qcBy: '质检员 · 赵敏',
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
      temp: suggested ? Math.round((suggested.tempRange[0] + suggested.tempRange[1]) / 2) : 100,
      duration: suggested?.duration ?? 12,
      startedAt: dayjs(record.startedAt),
      endedAt: dayjs(record.endedAt),
      operator: record.operator,
      degree: record.degree,
      remark: record.remark,
      reviewReason: undefined,
      qcBy: record.qcBy ?? '质检员 · 赵敏',
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

    // 已锁定批次 + 质检员改判开关：追加复核版本，不覆盖旧结论
    if (editing && isRejudge) {
      try {
        const result = await reviewAsQc(editing.id, {
          degree: values.degree,
          yieldRate,
          methodId: values.methodId,
          fireLevel: values.fireLevel,
          reason: values.reviewReason ?? '',
          qcBy: values.qcBy?.trim() || '质检员 · 赵敏',
        });
        message.success(
          `已生成复核版本 v${result.batch.reviews.length}（${previousReview?.degree}→${values.degree}，得率 ${previousReview?.yieldRate}%→${yieldRate}%）` +
            (result.pendingSamples > 0 ? `，${result.pendingSamples} 份关联留样已置为待复核` : ''),
        );
        setOpen(false);
      } catch (error) {
        message.error((error as Error).message);
      }
      return;
    }

    const payload = {
      batchNo: values.batchNo,
      herbId: values.herbId,
      methodId: values.methodId,
      feedKg,
      auxUsedKg: Number(values.auxUsedKg) || 0,
      fireLevel: values.fireLevel,
      startedAt: values.startedAt.toISOString(),
      endedAt: values.endedAt.toISOString(),
      yieldRate,
      degree: values.degree,
      operator: values.operator,
      remark: values.remark,
    };
    if (editing) {
      const ok = await updateBatch(editing.id, payload, qcMode);
      if (!ok) {
        message.error('该批已锁定，请打开「质检员复核改判」后再提交');
        return;
      }
      message.success(`已更新 ${payload.batchNo}，得率 ${yieldRate}%`);
    } else {
      await createBatch(payload, true);
      message.success(`已提交 ${payload.batchNo}，得率 ${yieldRate}%，该批已锁定并生成初判版本`);
    }
    setOpen(false);
  };

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
    { title: '程度', dataIndex: 'degree', width: 90, render: (v: ProcessDegree) => <Tag color={DEGREE_COLOR[v]}>{v}</Tag> },
    {
      title: '状态 / 版本',
      dataIndex: 'locked',
      width: 190,
      render: (locked: boolean, record) => (
        <Space size={4} wrap>
          {locked ? <Tag color="blue">已锁定{record.qcBy ? ` · ${record.qcBy}` : ''}</Tag> : <Tag>待判定</Tag>}
          {record.reviews.length > 0 ? (
            <Tag
              color={record.reviews.length > 1 ? 'gold' : 'default'}
              style={{ cursor: 'pointer' }}
              onClick={() => setHistoryTarget(record)}
            >
              判定 v{latestReview(record)?.version}（共 {record.reviews.length} 版）
            </Tag>
          ) : null}
        </Space>
      ),
    },
    { title: '操作人', dataIndex: 'operator', width: 90 },
    {
      title: '操作',
      width: 250,
      fixed: 'right',
      render: (_, record) => (
        <Space size={2}>
          <Button size="small" type="link" onClick={() => openEdit(record)}>
            {record.locked ? '质检改判' : '编辑'}
          </Button>
          {record.reviews.length > 0 ? (
            <Button size="small" type="link" onClick={() => setHistoryTarget(record)}>
              版本
            </Button>
          ) : null}
          {!record.locked ? (
            <Button size="small" type="link" onClick={() => lockBatch(record.id).then(() => message.success('已锁定该批并生成初判版本'))}>
              锁定
            </Button>
          ) : (
            <Button size="small" type="link" onClick={() => unlockAsQc(record.id, '质检员 · 赵敏').then(() => message.success('质检员已放行，可重新编辑'))}>
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

  const historyColumns: TableColumnsType<BatchReview> = [
    {
      title: '版本',
      dataIndex: 'version',
      width: 110,
      render: (v: number, record) => (
        <Space size={4}>
          <Tag color={record.kind === '初判' ? 'default' : 'gold'}>v{v}</Tag>
          <Text type="secondary">{record.kind}</Text>
        </Space>
      ),
    },
    { title: '程度', dataIndex: 'degree', width: 80, render: (v: ProcessDegree) => <Tag color={DEGREE_COLOR[v]}>{v}</Tag> },
    { title: '得率(%)', dataIndex: 'yieldRate', width: 90, align: 'right' },
    { title: '方法', dataIndex: 'methodId', width: 90, render: (id: string) => methodOf(id)?.name ?? '-' },
    { title: '火候', dataIndex: 'fireLevel', width: 80 },
    { title: '判定时间', dataIndex: 'judgedAt', width: 150, render: (v: string) => formatDate(v) },
    { title: '判定人', dataIndex: 'judgeBy', width: 120 },
    { title: '依据 / 改判原因', dataIndex: 'reason' },
  ];

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        炮制工序记录台
      </Title>
      <Paragraph type="secondary">
        选择方法即带出辅料比例、火候与判断标准；录入实际锅温、时长与炮制后重量，系统按标准自动给出程度判定，提交后锁定该批并生成初判版本。质检员改判会追加复核版本，保留前后程度、得率、方法与原因，留样按其所依据的版本继续观察。
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
        okText={isRejudge ? '提交复核改判（追加版本）' : editing ? '保存' : '提交并锁定该批'}
        cancelText="取消"
        width={760}
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
            // 改判时不自动覆盖质检员的人工判定
            if (!isRejudge && verdict && ('temp' in changed || 'duration' in changed || 'outputKg' in changed)) {
              form.setFieldsValue({ degree: verdict.degree } as unknown as BatchFormValues);
            }
          }}
        >
          {editing?.locked ? (
            <Alert
              type={isRejudge ? 'warning' : 'info'}
              showIcon
              style={{ marginBottom: 12 }}
              message={isRejudge ? '质检员复核改判：将追加新版本，旧判定完整保留' : '该批得率与程度已锁定，仅质检员可复核改判'}
              description={
                isRejudge && previousReview
                  ? `上一版 v${previousReview.version}：${previousReview.degree} / 得率 ${previousReview.yieldRate}% / ${methodOf(previousReview.methodId)?.name ?? '-'} · ${previousReview.fireLevel}（${previousReview.judgeBy}，${formatDate(previousReview.judgedAt)}）。改判为「太过」时，关联的观察中留样会先进入待复核。`
                  : '改判不会盖掉原结论，留样仍按其所依据的版本继续观察。'
              }
              action={<Switch checkedChildren="质检员复核改判" unCheckedChildren="只读" checked={qcMode} onChange={setQcMode} />}
            />
          ) : null}

          <Form.Item name="batchNo" label="生产批号" rules={[{ required: true, message: '请输入生产批号' }]}>
            <Input maxLength={24} disabled={Boolean(editing) || isRejudge} />
          </Form.Item>

          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="herbId" label="药材" rules={[{ required: true, message: '请选择药材' }]} style={{ flex: 1 }}>
              <Select
                showSearch
                optionFilterProp="label"
                disabled={Boolean(editing) || isRejudge}
                options={herbs.map((h) => ({ label: `${h.name} · ${h.batchNo}（${h.feedKg}kg）`, value: h.id }))}
              />
            </Form.Item>
            <Form.Item name="methodId" label="炮制方法" rules={[{ required: true, message: '请选择炮制方法' }]} style={{ flex: 1 }}>
              <Select
                disabled={!isRejudge && Boolean(editing?.locked)}
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
            <Form.Item name="fireLevel" label="火力" rules={[{ required: true, message: '请选择火力' }]}>
              <Select style={{ width: 120 }} disabled={!isRejudge && Boolean(editing?.locked)} options={FIRE_LEVELS.map((v) => ({ label: v, value: v }))} />
            </Form.Item>
            <Form.Item name="temp" label="实际锅温(℃)" rules={[{ required: true, message: '请输入实际锅温' }]}>
              <InputNumber min={0} max={800} style={{ width: 140 }} disabled={Boolean(editing?.locked)} />
            </Form.Item>
            <Form.Item name="duration" label="炮制时长(min)" rules={[{ required: true, message: '请输入炮制时长' }]}>
              <InputNumber min={0} style={{ width: 140 }} disabled={Boolean(editing?.locked)} />
            </Form.Item>
            <Form.Item name="outputKg" label="炮制后重量(kg)" rules={[{ required: true, message: '请输入炮制后重量' }]}>
              <InputNumber min={0} step={0.5} style={{ width: 150 }} disabled={!isRejudge && Boolean(editing?.locked)} />
            </Form.Item>
          </Space>

          <Form.Item name="feedKg" label="投料量(kg)" rules={[{ required: true, message: '请输入投料量' }]} style={{ maxWidth: 200 }}>
            <InputNumber min={0} step={1} style={{ width: '100%' }} disabled={Boolean(editing)} />
          </Form.Item>

          <Alert
            type={verdict?.degree === '适中' ? 'success' : verdict?.degree === '太过' ? 'error' : 'warning'}
            showIcon
            style={{ marginBottom: 12 }}
            message={`系统判定：${verdict?.degree ?? '待录入火候与得率'}（得率 ${watchedYieldRate}%，预期 ${verdict?.expectedYield ?? '-'}%）${isRejudge ? '（参考提示，不替代人工复核）' : ''}`}
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {(verdict?.reasons ?? ['选择方法并录入锅温、时长、炮制后重量后自动判定']).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            }
          />

          <Form.Item name="degree" label="程度判定（可按判断标准复核后修改）" rules={[{ required: true, message: '请选择程度' }]}>
            <Select disabled={!isRejudge && Boolean(editing?.locked)} options={PROCESS_DEGREES.map((v) => ({ label: v, value: v }))} />
          </Form.Item>

          {isRejudge ? (
            <Card size="small" type="inner" title="复核改判信息" style={{ marginBottom: 12 }}>
              <Space size={12} style={{ display: 'flex' }} align="start">
                <Form.Item name="qcBy" label="复核质检员" style={{ flex: 1 }} rules={[{ required: true, message: '请填写复核质检员' }]}>
                  <Input maxLength={16} />
                </Form.Item>
              </Space>
              <Form.Item
                name="reviewReason"
                label="改判原因（必填，随版本留痕）"
                rules={[{ required: true, message: '请说明本次改判原因' }]}
              >
                <Input.TextArea rows={3} maxLength={200} showCount placeholder="如：复核发现断面焦褐色、局部焦斑，复检水分后确认损耗过大，改判太过并隔离本批" />
              </Form.Item>
              {watched?.degree === '太过' && previousReview?.degree !== '太过' ? (
                <Alert type="error" showIcon message="程度转为「太过」：提交后关联的观察中留样将先置为「待复核」，由质检员说明理由后沿用原留样或重新取样。" />
              ) : null}
            </Card>
          ) : null}

          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="startedAt" label="开始时间" rules={[{ required: true, message: '请选择开始时间' }]}>
              <DatePicker showTime style={{ width: 190 }} disabled={Boolean(editing?.locked)} />
            </Form.Item>
            <Form.Item name="endedAt" label="结束时间" rules={[{ required: true, message: '请选择结束时间' }]}>
              <DatePicker showTime style={{ width: 190 }} disabled={Boolean(editing?.locked)} />
            </Form.Item>
            <Form.Item name="operator" label="操作人" rules={[{ required: true, message: '请填写操作人' }]}>
              <Input style={{ width: 140 }} maxLength={16} disabled={Boolean(editing?.locked)} />
            </Form.Item>
          </Space>

          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={80} disabled={isRejudge || Boolean(editing?.locked)} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={Boolean(historyTarget)}
        title={`判定版本链 · ${historyTarget?.batchNo ?? ''}`}
        onCancel={() => setHistoryTarget(null)}
        footer={<Button onClick={() => setHistoryTarget(null)}>关闭</Button>}
        width={960}
      >
        {historyTarget ? (
          <>
            <Paragraph type="secondary" style={{ marginBottom: 8 }}>
              改判只追加版本、不覆盖旧结论；留样绑定各自留样时所依据的版本。当前生效版本：
              <Tag color="gold" style={{ marginLeft: 6 }}>v{latestReview(historyTarget)?.version}</Tag>
              <Tag color={DEGREE_COLOR[historyTarget.degree]}>{historyTarget.degree}</Tag>
              得率 {historyTarget.yieldRate}%
            </Paragraph>
            <Table rowKey="id" size="small" columns={historyColumns} dataSource={historyTarget.reviews} pagination={false} />
            {historyTarget.reviews.length > 1 ? (
              <Timeline
                style={{ marginTop: 16 }}
                items={[...historyTarget.reviews]
                  .sort((a, b) => b.version - a.version)
                  .map((review) => ({
                    color: review.degree === '太过' ? 'red' : review.degree === '不及' ? 'orange' : 'green',
                    children: (
                      <div>
                        <Text strong>v{review.version}</Text> <Tag>{review.kind}</Tag>{' '}
                        <Tag color={DEGREE_COLOR[review.degree]}>{review.degree}</Tag>
                        <span style={{ fontSize: 12, color: '#6b7a70' }}>
                          得率 {review.yieldRate}% · {methodOf(review.methodId)?.name ?? '-'} · {review.fireLevel} · {review.judgeBy} · {formatDate(review.judgedAt)}
                        </span>
                        <div>{review.reason}</div>
                      </div>
                    ),
                  }))}
              />
            ) : null}
          </>
        ) : null}
      </Modal>
    </div>
  );
}
