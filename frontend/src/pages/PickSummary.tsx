/** /picks 优选 Take 汇总与备注：按用途排序并生成剪接清单 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
  message
} from 'antd';
import { HolderOutlined, PlusOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import FilterBar from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import TakeBadge from '@/components/common/TakeBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useIdbTable } from '@/hooks/useIdbTable';
import { usePickStore } from '@/stores/pickStore';
import {
  db,
  type EditListVersionRow,
  type PickRow,
  type ProjectRow,
  type SessionRow,
  type SongRow,
  type TakeRow
} from '@/utils/db';
import { PICK_USAGES, createEmptyPick, type Pick } from '@/types/pick';
import type { FilterModel, FilterSelectConfig } from '@/types/filter';
import { buildEditList, formatDuration, takeDuration, totalDuration } from '@/utils/timecode';
import { deriveEditListStatus, formatConfirmedAt } from '@/utils/editList';
import type { EditListInvalidRef } from '@/types/editList';

const asArray = (value: string | string[] | boolean | undefined): string[] => (Array.isArray(value) ? value : []);

export default function PickSummary() {
  const [searchParams, setSearchParams] = useSearchParams();
  const picks = useIdbTable<PickRow>(db.picks);
  const takes = useIdbTable<TakeRow>(db.takes);
  const sessions = useIdbTable<SessionRow>(db.sessions);
  const songs = useIdbTable<SongRow>(db.songs);
  const projects = useIdbTable<ProjectRow>(db.projects);
  const editListVersions = useIdbTable<EditListVersionRow>(db.editListVersions);

  const filters = usePickStore((state) => state.filters);
  const setFilters = usePickStore((state) => state.setFilters);
  const resetFilters = usePickStore((state) => state.resetFilters);
  const createPick = usePickStore((state) => state.createPick);
  const editPick = usePickStore((state) => state.editPick);
  const deletePick = usePickStore((state) => state.deletePick);
  const move = usePickStore((state) => state.move);
  const confirmEditList = usePickStore((state) => state.confirmEditList);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PickRow | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [form] = Form.useForm<Omit<Pick, 'id' | 'order'>>();

  useEffect(() => {
    setFilters({
      keyword: searchParams.get('keyword') ?? '',
      usages: searchParams.get('usages') ? (searchParams.get('usages') as string).split(',') : []
    });
    // 仅首次挂载还原 URL 筛选
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyFilters(next: FilterModel): void {
    setFilters(next);
    const params: Record<string, string> = {};
    if (String(next.keyword ?? '').length > 0) params.keyword = String(next.keyword);
    asArray(next.usages).length > 0 && (params.usages = asArray(next.usages).join(','));
    setSearchParams(params, { replace: true });
  }

  const takeOf = (takeId: string): TakeRow | null => takes.find((item) => item.id === takeId) ?? null;

  const sessionLabel = (sessionId: string): string => {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return '场次已删除';
    const song = songs.find((item) => item.id === session.songId);
    const project = song ? projects.find((item) => item.id === song.projectId) : undefined;
    return `${song ? song.title : '未知曲目'}${project ? ` · ${project.name}` : ''} · ${session.date} ${session.period}`;
  };

  const filtered = useMemo(() => {
    const keyword = String(filters.keyword ?? '').trim().toLowerCase();
    const usages = asArray(filters.usages);
    return picks
      .filter((pick) => {
        const take = takeOf(pick.takeId);
        const label = `${pick.usage} ${pick.note} ${take ? take.takeNo : ''}`.toLowerCase();
        if (keyword && !label.includes(keyword)) return false;
        if (usages.length > 0 && !usages.includes(pick.usage)) return false;
        return true;
      })
      .sort((a, b) => a.order - b.order);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picks, takes, filters]);

  const editList = useMemo(
    () =>
      filtered
        .map((pick) => takeOf(pick.takeId))
        .filter((take): take is TakeRow => take !== null)
        .map((take) => ({ takeNo: take.takeNo, startTc: take.startTc, endTc: take.endTc })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, takes]
  );

  const totals = useMemo(() => {
    const usable = takes.filter((take) => take.grade === '可用').length;
    return {
      pickCount: picks.length,
      usableTakeCount: usable,
      pickRatio: usable > 0 ? Math.round((picks.length / usable) * 100) : 0,
      durationText: formatDuration(totalDuration(editList)),
      usageCount: new Set(picks.map((item) => item.usage)).size
    };
  }, [picks, takes, editList]);

  /** 只有「可用」评级且尚未被优选的条次可作为候选 */
  const candidates = useMemo(
    () => takes.filter((take) => take.grade === '可用' && !picks.some((pick) => pick.takeId === take.id)),
    [takes, picks]
  );

  /** 剪接清单对账：评级一改即失效，旧确认版仍可查，重新确认前导出停住 */
  const editListStatus = useMemo(
    () => deriveEditListStatus({ picks, takes, versions: editListVersions }),
    [picks, takes, editListVersions]
  );

  /** 失效引用按 pickId 索引，卡片上点名标红 */
  const invalidRefMap = useMemo(() => {
    const map = new Map<string, EditListInvalidRef>();
    editListStatus.invalidRefs.forEach((ref) => map.set(ref.pickId, ref));
    return map;
  }, [editListStatus]);

  async function handleConfirmEditList(): Promise<void> {
    try {
      const version = await confirmEditList();
      message.success(`剪接清单 v${version.version} 已确认，可以导出场次记录表`);
    } catch (confirmError) {
      const text = confirmError instanceof Error ? confirmError.message : '确认失败';
      message.error(text);
    }
  }

  async function submit(): Promise<void> {
    const values = await form.validateFields();
    if (editing) {
      await editPick(editing.id, values);
      message.success('优选记录已更新');
    } else {
      await createPick(values);
      message.success('已加入剪接清单');
    }
    setDialogOpen(false);
    setEditing(null);
    form.resetFields();
  }

  async function handleDrop(index: number): Promise<void> {
    const from = dragIndex;
    setDragIndex(null);
    setOverIndex(null);
    if (from === null || from === index) return;
    await move(filtered as Pick[], from, index);
    message.success('剪接顺序已更新并写回本地库');
  }

  const selects: FilterSelectConfig[] = [
    { key: 'usages', label: '用途', options: PICK_USAGES.map((item) => ({ label: item, value: item })) }
  ];

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h2 className="page__title">优选 Take 汇总与剪接清单</h2>
          <p className="page__subtitle">从「可用」评级的条次中挑选，拖拽卡片或用上下移按钮调整剪接顺序。</p>
        </div>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          disabled={candidates.length === 0}
          onClick={() => {
            setEditing(null);
            form.setFieldsValue({ ...createEmptyPick(), takeId: candidates[0]?.id ?? '' });
            setDialogOpen(true);
          }}
        >
          加入优选
        </Button>
      </div>

      <div className="badge-row">
        <StatBadge label="优选条次" value={totals.pickCount} suffix="条" tone="primary" icon="files" />
        <StatBadge label="可用 Take" value={totals.usableTakeCount} suffix="条" tone="success" icon="grid" />
        <StatBadge label="优选覆盖率" value={totals.pickRatio} percent={totals.pickRatio} showPercent tone="warning" icon="pie" />
        <StatBadge label="剪接总时长" value={totals.durationText} tone="info" icon="histogram" />
        <StatBadge label="用途种类" value={totals.usageCount} suffix="类" tone="danger" icon="trend" />
      </div>

      {picks.length > 0 ? (
        <Alert
          type={editListStatus.state === 'confirmed' ? 'success' : editListStatus.state === 'stale' ? 'error' : 'warning'}
          showIcon
          style={{ marginBottom: 12 }}
          message={
            <Space wrap>
              <SafetyCertificateOutlined />
              <span>
                {editListStatus.state === 'confirmed'
                  ? `剪接清单确认版 v${editListStatus.latest?.version}（${formatConfirmedAt(
                      editListStatus.latest?.confirmedAt ?? 0
                    )} 确认）有效`
                  : editListStatus.state === 'stale'
                    ? `剪接清单已失效，最新确认版 v${editListStatus.latest?.version} 仍可查，重新确认前导出停住`
                    : '剪接清单尚未确认'}
              </span>
              <Button
                size="small"
                type={editListStatus.state === 'confirmed' ? 'default' : 'primary'}
                onClick={() => void handleConfirmEditList()}
              >
                {editListStatus.latest ? '重新确认当前清单' : '确认当前清单'}
              </Button>
            </Space>
          }
          description={
            <Space direction="vertical" size={2}>
              <span>{editListStatus.message}</span>
              {editListStatus.invalidRefs.map((ref) => (
                <span key={ref.pickId} style={{ color: '#cf1322' }}>
                  · {ref.reasonText}
                </span>
              ))}
            </Space>
          }
        />
      ) : null}

      <FilterBar
        modelValue={filters}
        selects={selects}
        keywordPlaceholder="搜索用途 / 备注 / Take 号…"
        onChange={applyFilters}
        onReset={() => {
          resetFilters();
          setSearchParams({}, { replace: true });
        }}
        extra={<Tag color="blue">候选可用 Take {candidates.length} 条</Tag>}
      />

      {filtered.length === 0 ? (
        <EmptyPanel
          title="剪接清单还是空的"
          description="从可用评级的 Take 中挑选片段，组成主歌 / 副歌 / 独奏的剪接清单。"
          showCreate={candidates.length > 0}
          createText="加入优选"
          onCreate={() => {
            setEditing(null);
            form.setFieldsValue({ ...createEmptyPick(), takeId: candidates[0]?.id ?? '' });
            setDialogOpen(true);
          }}
        />
      ) : (
        <Row gutter={16}>
          <Col xs={24} xl={15}>
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              {filtered.map((pick, index) => {
                const take = takeOf(pick.takeId);
                const invalidRef = invalidRefMap.get(pick.id);
                return (
                  <Card
                    key={pick.id}
                    size="small"
                    draggable
                    className={[
                      dragIndex === index ? 'is-dragging' : '',
                      overIndex === index ? 'is-over' : '',
                      invalidRef ? 'pick-card-invalid' : ''
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onDragStart={() => setDragIndex(index)}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setOverIndex(index);
                    }}
                    onDrop={() => void handleDrop(index)}
                    onDragEnd={() => setDragIndex(null)}
                    title={
                      <Space>
                        <HolderOutlined className="drag-handle" />
                        <span>#{index + 1}</span>
                        <Tag color="blue">{pick.usage}</Tag>
                        {take ? <TakeBadge grade={take.grade} issues={take.issues} showIssues={false} /> : null}
                        {invalidRef ? <Tag color="error">已失效</Tag> : null}
                      </Space>
                    }
                    extra={
                      <Space>
                        <Button
                          size="small"
                          disabled={index === 0}
                          onClick={() => void move(filtered as Pick[], index, index - 1)}
                        >
                          上移
                        </Button>
                        <Button
                          size="small"
                          disabled={index === filtered.length - 1}
                          onClick={() => void move(filtered as Pick[], index, index + 1)}
                        >
                          下移
                        </Button>
                        <Button
                          size="small"
                          type="link"
                          onClick={() => {
                            setEditing(pick);
                            form.setFieldsValue({ takeId: pick.takeId, usage: pick.usage, note: pick.note });
                            setDialogOpen(true);
                          }}
                        >
                          编辑
                        </Button>
                        <Popconfirm
                          title="移出剪接清单？"
                          onConfirm={async () => {
                            await deletePick(pick.id);
                            message.success('已移出剪接清单');
                          }}
                        >
                          <Button size="small" type="link" danger>
                            删除
                          </Button>
                        </Popconfirm>
                      </Space>
                    }
                  >
                    <Space direction="vertical" size={2}>
                      <Typography.Text>
                        {take ? `${take.takeNo} · ${take.startTc} → ${take.endTc}` : '条次已删除'}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {take ? `${sessionLabel(take.sessionId)} · 时长 ${formatDuration(takeDuration(take.startTc, take.endTc))}` : '—'}
                      </Typography.Text>
                      <Typography.Text type="secondary">备注：{pick.note || '—'}</Typography.Text>
                      {invalidRef ? (
                        <Typography.Text type="danger">失效原因：{invalidRef.reasonText}（重新确认前不能导出）</Typography.Text>
                      ) : null}
                    </Space>
                  </Card>
                );
              })}
            </Space>
          </Col>
          <Col xs={24} xl={9}>
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Card
                title="剪接清单（自动生成）"
                extra={
                  <Tag color={editListStatus.state === 'confirmed' ? 'success' : editListStatus.state === 'stale' ? 'error' : 'warning'}>
                    {editListStatus.state === 'confirmed'
                      ? `已确认 v${editListStatus.latest?.version}`
                      : editListStatus.state === 'stale'
                        ? '已失效 · 导出停住'
                        : '未确认 · 导出停住'}
                  </Tag>
                }
              >
                {editList.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可拼接的片段" />
                ) : (
                  <List
                    size="small"
                    dataSource={editList}
                    footer={
                      <Typography.Text strong>
                        合计时长 {formatDuration(totalDuration(editList))} · 共 {editList.length} 段
                      </Typography.Text>
                    }
                    renderItem={(item, index) => (
                      <List.Item>
                        <Space>
                          <Tag>{index + 1}</Tag>
                          <span>{item.takeNo}</span>
                          <Typography.Text type="secondary">
                            {item.startTc} → {item.endTc}
                          </Typography.Text>
                        </Space>
                      </List.Item>
                    )}
                  />
                )}
                <Typography.Paragraph copyable={{ text: buildEditList(editList) }} style={{ marginTop: 12 }}>
                  <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>{buildEditList(editList) || '（空）'}</pre>
                </Typography.Paragraph>
              </Card>

              <Card title={`剪接清单确认版历史（${editListVersions.length}）`}>
                {editListVersions.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有确认版，确认当前清单后才能导出" />
                ) : (
                  <Timeline
                    items={editListVersions.map((version) => ({
                      color: editListStatus.latest?.id === version.id && editListStatus.state === 'confirmed' ? 'green' : 'gray',
                      children: (
                        <Space direction="vertical" size={2}>
                          <Space>
                            <Typography.Text strong>v{version.version}</Typography.Text>
                            <Tag>{version.entries.length} 段</Tag>
                            <Typography.Text type="secondary">{formatConfirmedAt(version.confirmedAt)}</Typography.Text>
                            {editListStatus.latest?.id === version.id ? <Tag color="blue">最新确认版</Tag> : null}
                          </Space>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {version.entries
                              .map((entry) => `${entry.order}. ${entry.takeNo}（${entry.grade}）`)
                              .join('　')}
                          </Typography.Text>
                        </Space>
                      )
                    }))}
                  />
                )}
              </Card>
            </Space>
          </Col>
        </Row>
      )}

      <Card title="优选明细表">
        <Table<PickRow>
          rowKey="id"
          dataSource={[...filtered].sort((a, b) => a.order - b.order)}
          pagination={false}
          locale={{ emptyText: '暂无优选记录' }}
          columns={[
            { title: '顺序', dataIndex: 'order', width: 80 },
            { title: '用途', dataIndex: 'usage', width: 100 },
            {
              title: '条次',
              minWidth: 200,
              render: (_, row) => {
                const take = takeOf(row.takeId);
                return take ? `${take.takeNo} · ${take.startTc} → ${take.endTc}` : '条次已删除';
              }
            },
            { title: '备注', dataIndex: 'note', minWidth: 200 },
            {
              title: '时长',
              width: 100,
              render: (_, row) => {
                const take = takeOf(row.takeId);
                return take ? formatDuration(takeDuration(take.startTc, take.endTc)) : '—';
              }
            }
          ]}
        />
      </Card>

      <Modal
        open={dialogOpen}
        title={editing ? '编辑优选记录' : '加入剪接清单'}
        onCancel={() => setDialogOpen(false)}
        onOk={submit}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="takeId" label="条次" rules={[{ required: true, message: '请选择条次' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={(editing ? takes.filter((take) => take.grade === '可用' || take.id === editing.takeId) : candidates).map(
                (take) => ({
                  label: `${take.takeNo} · ${take.startTc} → ${take.endTc}`,
                  value: take.id
                })
              )}
            />
          </Form.Item>
          <Form.Item name="usage" label="用途" rules={[{ required: true }]}>
            <Select options={PICK_USAGES.map((item) => ({ label: item, value: item }))} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="如：鼓组干净，可作主歌第一段" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
