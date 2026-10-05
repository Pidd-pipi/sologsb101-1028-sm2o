/** /picks 优选 Take 汇总与备注：按用途排序并生成剪接清单，评级改动即失效并需重新确认 */
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
import { CheckCircleOutlined, HistoryOutlined, HolderOutlined, PlusOutlined } from '@ant-design/icons';
import FilterBar from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import TakeBadge from '@/components/common/TakeBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useIdbTable } from '@/hooks/useIdbTable';
import { usePickStore } from '@/stores/pickStore';
import {
  confirmPickList,
  db,
  type PickRow,
  type PickSnapshotRow,
  type ProjectRow,
  type SessionRow,
  type SongRow,
  type TakeRow
} from '@/utils/db';
import { PICK_USAGES, createEmptyPick, type Pick } from '@/types/pick';
import type { FilterModel, FilterSelectConfig } from '@/types/filter';
import { assessPickList } from '@/utils/pickList';
import { buildEditList, formatDuration, takeDuration, totalDuration } from '@/utils/timecode';

const asArray = (value: string | string[] | boolean | undefined): string[] => (Array.isArray(value) ? value : []);

export default function PickSummary() {
  const [searchParams, setSearchParams] = useSearchParams();
  const picks = useIdbTable<PickRow>(db.picks);
  const takes = useIdbTable<TakeRow>(db.takes);
  const sessions = useIdbTable<SessionRow>(db.sessions);
  const songs = useIdbTable<SongRow>(db.songs);
  const projects = useIdbTable<ProjectRow>(db.projects);
  const snapshots = useIdbTable<PickSnapshotRow>(db.pickSnapshots);

  const filters = usePickStore((state) => state.filters);
  const setFilters = usePickStore((state) => state.setFilters);
  const resetFilters = usePickStore((state) => state.resetFilters);
  const createPick = usePickStore((state) => state.createPick);
  const editPick = usePickStore((state) => state.editPick);
  const deletePick = usePickStore((state) => state.deletePick);
  const move = usePickStore((state) => state.move);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PickRow | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [form] = Form.useForm<Omit<Pick, 'id' | 'order' | 'snapshotGrade'>>();

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

  /** 全量清单（不过滤）的确认状态，决定导出能否放行 */
  const assessment = useMemo(() => assessPickList(picks, takes, snapshots), [picks, takes, snapshots]);

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

  /** 单条优选是否因评级改动而失效 */
  const isPickStale = (pick: PickRow): boolean =>
    pick.snapshotGrade !== null && (() => {
      const take = takeOf(pick.takeId);
      return !take || take.grade !== pick.snapshotGrade;
    })();

  async function submit(): Promise<void> {
    const values = await form.validateFields();
    if (editing) {
      await editPick(editing.id, values);
      message.success('优选记录已更新，需重新确认后才能导出');
    } else {
      await createPick(values);
      message.success('已加入剪接清单（未确认，确认后才能导出）');
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

  async function handleConfirm(): Promise<void> {
    setConfirming(true);
    try {
      await confirmPickList();
      message.success('剪接清单已按当前 Take 评级重新确认，可以导出');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '确认失败');
    } finally {
      setConfirming(false);
    }
  }

  const selects: FilterSelectConfig[] = [
    { key: 'usages', label: '用途', options: PICK_USAGES.map((item) => ({ label: item, value: item })) }
  ];

  const banner = (() => {
    if (assessment.status === 'confirmed') {
      return (
        <Alert
          type="success"
          showIcon
          icon={<CheckCircleOutlined />}
          message={`剪接清单已确认（${assessment.latestSnapshot?.confirmedAt.slice(0, 19).replace('T', ' ')}），可以导出场次记录表`}
        />
      );
    }
    if (assessment.status === 'empty') return null;
    return (
      <Alert
        type="error"
        showIcon
        message={
          assessment.status === 'staleGrade'
            ? 'Take 评级已修改，引用它的优选清单立即失效；重新确认前导出停住'
            : assessment.status === 'neverConfirmed'
              ? '剪接清单尚未确认；确认前导出停住'
              : '剪接清单与最近确认版不一致；重新确认前导出停住'
        }
        description={
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <span>{assessment.reason}</span>
            {assessment.driftReasons.slice(0, 6).map((reason) => (
              <span className="muted" key={reason}>
                · {reason}
              </span>
            ))}
            <Button type="primary" size="small" loading={confirming} onClick={handleConfirm}>
              按当前清单重新确认
            </Button>
          </Space>
        }
      />
    );
  })();

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h2 className="page__title">优选 Take 汇总与剪接清单</h2>
          <p className="page__subtitle">
            从「可用」评级的条次中挑选排序；Take 评级一改动，引用它的优选立即失效，重新确认前导出停住，旧确认版仍可翻查。
          </p>
        </div>
        <Space>
          <Button icon={<HistoryOutlined />} disabled={snapshots.length === 0} onClick={() => setHistoryOpen(true)}>
            旧确认版（{snapshots.length}）
          </Button>
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
        </Space>
      </div>

      <div className="badge-row">
        <StatBadge label="优选条次" value={totals.pickCount} suffix="条" tone="primary" icon="files" />
        <StatBadge label="可用 Take" value={totals.usableTakeCount} suffix="条" tone="success" icon="grid" />
        <StatBadge label="优选覆盖率" value={totals.pickRatio} percent={totals.pickRatio} showPercent tone="warning" icon="pie" />
        <StatBadge label="剪接总时长" value={totals.durationText} tone="info" icon="histogram" />
        <StatBadge label="用途种类" value={totals.usageCount} suffix="类" tone="danger" icon="trend" />
      </div>

      {banner}

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
                const stale = isPickStale(pick);
                return (
                  <Card
                    key={pick.id}
                    size="small"
                    draggable
                    className={
                      stale ? 'pick-card-stale' : dragIndex === index ? 'is-dragging' : overIndex === index ? 'is-over' : ''
                    }
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
                        {stale ? (
                          <Tag color="red">
                            失效（{pick.snapshotGrade ?? '未确认'}→{take ? take.grade : '已删除'}）
                          </Tag>
                        ) : pick.snapshotGrade === null ? (
                          <Tag color="orange">未确认</Tag>
                        ) : null}
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
                    </Space>
                  </Card>
                );
              })}
            </Space>
          </Col>
          <Col xs={24} xl={9}>
            <Card
              title="剪接清单（自动生成）"
              extra={
                assessment.status === 'confirmed' ? (
                  <Tag color="green">已确认</Tag>
                ) : (
                  <Tag color="red">{assessment.status === 'neverConfirmed' ? '未确认' : '失效待确认'}</Tag>
                )
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
              <Space style={{ marginTop: 4 }}>
                <Button type="primary" loading={confirming} onClick={handleConfirm}>
                  {assessment.latestSnapshot ? '重新确认当前清单' : '确认当前清单'}
                </Button>
                <Typography.Text type="secondary" className="muted">
                  {assessment.latestSnapshot
                    ? `上次确认：${assessment.latestSnapshot.confirmedAt.slice(0, 19).replace('T', ' ')}`
                    : '尚未确认'}
                </Typography.Text>
              </Space>
            </Card>
          </Col>
        </Row>
      )}

      <Card title="优选明细表">
        <Table<PickRow>
          rowKey="id"
          dataSource={[...filtered].sort((a, b) => a.order - b.order)}
          pagination={false}
          locale={{ emptyText: '暂无优选记录' }}
          rowClassName={(row) => (isPickStale(row) ? 'pick-row-stale' : '')}
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
            },
            {
              title: '确认状态',
              width: 180,
              render: (_, row) => {
                const take = takeOf(row.takeId);
                if (!take) return <Tag color="red">条次已删除</Tag>;
                if (row.snapshotGrade === null) return <Tag color="orange">未确认</Tag>;
                if (row.snapshotGrade !== take.grade) {
                  return (
                    <Tag color="red">
                      失效：{row.snapshotGrade}→{take.grade}
                    </Tag>
                  );
                }
                return <Tag color="green">与确认版一致</Tag>;
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

      <Modal
        open={historyOpen}
        title="剪接清单旧确认版（仅查看，导出以最新确认为准）"
        footer={null}
        onCancel={() => setHistoryOpen(false)}
        width={720}
      >
        <Timeline
          items={snapshots.map((snapshot, index) => ({
            color: index === 0 ? 'green' : 'gray',
            children: (
              <Card
                size="small"
                title={
                  <Space>
                    <span>{snapshot.confirmedAt.slice(0, 19).replace('T', ' ')}</span>
                    {index === 0 ? <Tag color="green">最新确认版</Tag> : <Tag>旧版</Tag>}
                    <span className="muted">{snapshot.itemCount} 段</span>
                  </Space>
                }
              >
                <List
                  size="small"
                  dataSource={snapshot.items}
                  renderItem={(item) => (
                    <List.Item>
                      <Space wrap>
                        <Tag>{item.order}</Tag>
                        <span>{item.takeNo}</span>
                        <Tag color="blue">{item.usage}</Tag>
                        <Typography.Text type="secondary">
                          {item.startTc} → {item.endTc}
                        </Typography.Text>
                        <Tag color={item.grade === '可用' ? 'green' : item.grade === '废' ? 'red' : 'orange'}>
                          {item.grade ?? '条次已删除'}
                        </Tag>
                        {item.note ? <Typography.Text type="secondary">备注：{item.note}</Typography.Text> : null}
                      </Space>
                    </List.Item>
                  )}
                />
              </Card>
            )
          }))}
        />
      </Modal>
    </div>
  );
}
