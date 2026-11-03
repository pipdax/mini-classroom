import { useRef, useState } from 'react';
import { type CognitiveMap, type MapPoint, type MapTopic, api } from '../api';
import { AskPanel, type AskPanelHandle } from '../components/AskPanel';
import { Icon } from '../components/Icon';
import { RecordView } from '../components/RecordView';
import { SelectionToAsk } from '../components/SelectionToAsk';
import { StageLadder, StageLegend } from '../components/StageLadder';
import { useResource } from '../hooks';
import { masteryBarWidth, masteryHue } from '../../domain/mastery';
import { STAGE_LABEL, relativeDue } from '../labels';
import { navigate, routeHash } from '../router';

/**
 * 认知地图要回答：我掌握到哪了？下一步能学什么？
 * 注意力顺序：结论（已学会多少）→ 接下来（今天要复习的、下一步可学的，能直接去学）→ 全图（按主题的知识点卡片，
 * 图例就在卡片上方）→ 辅助内容（联结、已有知识）。点开知识点时，详情在右侧，地图让出位置。
 */
export function MapScreen({ pointId }: { pointId?: string }) {
  const map = useResource(() => api.map(), []);
  const [excludedOnly, setExcludedOnly] = useState(false);
  const data = map.data;
  const learned = data?.topics.reduce((n, t) => n + t.learned, 0) ?? 0;
  const total = data?.topics.reduce((n, t) => n + t.total, 0) ?? 0;
  const excluded = data?.topics.reduce((n, t) => n + t.excluded, 0) ?? 0;
  const shownTopics = data?.topics.filter((topic) => !excludedOnly || topic.excluded > 0) ?? [];

  function filterPoints(onlyExcluded: boolean) {
    setExcludedOnly(onlyExcluded);
    if (onlyExcluded && pointId && !data?.points.find((p) => p.id === pointId)?.excluded) {
      navigate({ name: 'map' });
    }
  }

  return (
    <>
      <div className="title-row">
        <div>
          <h1>认知地图</h1>
          <p className="sub">{data ? summaryLine(data, learned, total) : '正在读取…'}</p>
        </div>
      </div>
      {map.error && <p className="error-text">没能读取认知地图：{map.error}</p>}
      {data && data.topics.length === 0 && <div className="empty">还没有学习主题。回到"今天"添加一个想学的主题。</div>}
      {data && data.topics.length > 0 && (
        <>
          <div className="actions-row" style={{ marginBottom: 20 }}>
            <div className="segmented" role="group" aria-label="知识点筛选">
              <button type="button" aria-pressed={!excludedOnly} onClick={() => filterPoints(false)}>全部（{total}）</button>
              <button type="button" aria-pressed={excludedOnly} onClick={() => filterPoints(true)}>只看不学（{excluded}）</button>
            </div>
            {excludedOnly && <span className="muted small">点开知识点可重新加入学习，恢复后会从此列表移除。</span>}
          </div>
          {!pointId && !excludedOnly && <NextUp map={data} />}
          {!excludedOnly && (
            <div className="map-legend">
              <StageLegend withMap />
              <MasteryLegend />
            </div>
          )}
          <div className="grid top">
            {pointId && (
              <aside className="span-4 rail" style={{ gridColumn: '9 / -1', gridRow: 1 }}>
                <PointPanel key={pointId} pointId={pointId} map={data} onChanged={map.reload} />
              </aside>
            )}
            <div className="stack" style={{ gridColumn: pointId ? '1 / 9' : '1 / -1', gridRow: 1 }}>
              {shownTopics.map((topic) => (
                <TopicSection key={topic.id} topic={topic} map={data} selected={pointId} excludedOnly={excludedOnly} />
              ))}
              {excludedOnly && shownTopics.length === 0 && (
                <div className="empty" role="status">
                  <p>没有选择不学的知识点。</p>
                  <button type="button" className="btn small" style={{ marginTop: 12 }} onClick={() => filterPoints(false)}>查看全部知识点</button>
                </div>
              )}
            </div>
          </div>
          {!pointId && !excludedOnly && (
            <div className="grid top section-gap">
              <div className="span-6">
                <Connections map={data} />
              </div>
              <div className="span-6">
                <ExistingKnowledge map={data} onChanged={map.reload} />
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

function summaryLine(map: CognitiveMap, learned: number, total: number): string {
  const edge = map.topics.reduce((n, t) => n + t.edge, 0);
  const due = map.topics.reduce((n, t) => n + t.due, 0);
  const parts = [`已学会 ${learned} / ${total} 个知识点`, due > 0 ? `今天要复习 ${due} 个` : '今天没有到期的复习', `下一步可学 ${edge} 个`];
  const excluded = map.topics.reduce((n, t) => n + t.excluded, 0);
  if (excluded > 0) parts.push(`${excluded} 个不学`);
  return parts.join(' · ');
}

/** 接下来：今天要复习的（最容易忘的在前）和下一步可学的，点开看详情，或直接去开始一节 */
function NextUp({ map }: { map: CognitiveMap }) {
  const now = Date.now();
  const due = map.points
    .filter((p) => p.nextReviewAt !== null && new Date(p.nextReviewAt).getTime() <= now && p.stage !== 'unlearned' && p.stage !== 'understand')
    .sort((a, b) => new Date(a.nextReviewAt!).getTime() - new Date(b.nextReviewAt!).getTime());
  const edge = map.points.filter((p) => p.onEdge);
  const topicOf = new Map(map.topics.map((t) => [t.id, t.title]));
  if (due.length === 0 && edge.length === 0) return null;
  const rows = (list: MapPoint[], limit: number) => (
    <div className="next-up-rows">
      {list.slice(0, limit).map((p) => (
        <a key={p.id} className="row-card" style={{ minHeight: 52 }} href={routeHash({ name: 'map', pointId: p.id })}>
          <span className="row-main">
            <span className="row-title">{p.title}</span>
            <span className="row-sub">
              {topicOf.get(p.topicId)} · {p.onEdge ? '可继续学习' : p.stageLabel}
            </span>
          </span>
          <MasteryBar mastery={p.mastery} inline />
        </a>
      ))}
    </div>
  );
  const more = (list: MapPoint[], limit: number) => list.length > limit && <p className="muted small" style={{ marginTop: 8 }}>还有 {list.length - limit} 个</p>;
  // 两类都有时并排；只有一类时它占满宽度，另一类缩成一句话，不留半边空白
  const both = due.length > 0 && edge.length > 0;
  const limit = both ? 4 : 6;
  return (
    <section className="panel next-up" aria-labelledby="next-up-title">
      <header>
        <h2 id="next-up-title">接下来</h2>
        <a className="btn primary small" href={routeHash({ name: 'today' })}>
          去开始一节
        </a>
      </header>
      {both ? (
        <div className="next-up-columns">
          <div>
            <h3 className="next-up-title">
              今天要复习 <span className="chip">{due.length}</span>
            </h3>
            {rows(due, limit)}
            {more(due, limit)}
          </div>
          <div>
            <h3 className="next-up-title">
              下一步可学 <span className="chip">{edge.length}</span>
            </h3>
            {rows(edge, limit)}
            {more(edge, limit)}
          </div>
        </div>
      ) : (
        <>
          <h3 className="next-up-title">
            {due.length > 0 ? '今天要复习' : '下一步可学'} <span className="chip">{due.length > 0 ? due.length : edge.length}</span>
            <span style={{ fontWeight: 400 }}>· {due.length > 0 ? '没有可学的新知识点' : '今天没有到期的复习'}</span>
          </h3>
          <div className="wide-rows">{rows(due.length > 0 ? due : edge, limit)}</div>
          {more(due.length > 0 ? due : edge, limit)}
        </>
      )}
    </section>
  );
}

/** 掌握程度条：最短 1/4（完全没掌握，红色），越掌握越长越绿，完全掌握占满（绿色） */
export function MasteryBar({ mastery, inline = false }: { mastery: number; inline?: boolean }) {
  const percent = Math.round(mastery * 100);
  return (
    <span className={`mastery ${inline ? 'inline' : ''}`} role="img" aria-label={`掌握程度 ${percent}%`}>
      <i style={{ width: `${masteryBarWidth(mastery) * 100}%`, background: `hsl(${masteryHue(mastery)} 62% 40%)` }} />
    </span>
  );
}

function MasteryLegend() {
  return (
    <div className="legend">
      <span>掌握程度：</span>
      {[
        { m: 0, label: '没掌握' },
        { m: 0.5, label: '一半' },
        { m: 1, label: '完全掌握' },
      ].map(({ m, label }) => (
        <span key={label}>
          <span className="mastery-sample">
            <MasteryBar mastery={m} inline />
          </span>
          {label}
        </span>
      ))}
    </div>
  );
}

/** 一个主题在地图上的部分：知识点卡片按推荐顺序排列，组块合并显示 */
export function TopicSection(props: { topic: MapTopic; map: CognitiveMap; selected?: string; showTitle?: boolean; excludedOnly?: boolean }) {
  const { topic, map, selected, showTitle = true, excludedOnly = false } = props;
  const points = map.points.filter((p) => p.topicId === topic.id && (!excludedOnly || p.excluded));
  const chunks = excludedOnly ? [] : map.chunks.filter((c) => points.some((p) => p.id === c.wholeId));
  const inChunk = new Set(chunks.flatMap((c) => [c.wholeId, ...c.partIds]));
  const byId = new Map(map.points.map((p) => [p.id, p]));

  return (
    <section className="panel" aria-labelledby={`topic-${topic.id}`}>
      <div className="topic-head">
        {showTitle ? (
          <h2 id={`topic-${topic.id}`} style={{ fontSize: 15 }}>
            <a href={routeHash({ name: 'topic', topicId: topic.id })}>{topic.title}</a>
            {topic.status === 'paused' && <span className="pill">已暂停</span>}
          </h2>
        ) : (
          <h2 id={`topic-${topic.id}`}>知识点</h2>
        )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {!excludedOnly && <>
              <StageLadder stages={points.map((p) => p.stage)} label={topic.title} />
              <span className="muted small num">
                {topic.learned} / {topic.total}
              </span>
            </>}
            {topic.excluded > 0 && <span className="pill learning-excluded">不学 {topic.excluded}</span>}
          </div>
      </div>
      {topic.graphStatus !== 'ready' ? (
        <div className="empty">{topic.graphStatus === 'pending' ? '知识图谱正在生成…' : '知识图谱生成失败，可以删掉重建这个主题。'}</div>
      ) : (
        <div className="map-grid">
          {chunks.map((chunk) => {
            const whole = byId.get(chunk.wholeId)!;
            return (
              <button
                key={chunk.wholeId}
                type="button"
                className="point chunk st-retain"
                aria-current={selected === whole.id}
                onClick={() => navigate({ name: 'map', pointId: whole.id })}
              >
                <span className="p-title">{whole.title}</span>
                <span className="parts">{chunk.partIds.map((id) => byId.get(id)?.title).join(' · ')}</span>
                <span className="p-meta">组块 · 全部进入保持阶段</span>
                <MasteryBar mastery={whole.mastery} />
              </button>
            );
          })}
          {points
            .filter((p) => !inChunk.has(p.id))
            .map((point) => (
              <PointCard key={point.id} point={point} selected={selected === point.id} />
            ))}
        </div>
      )}
    </section>
  );
}

function PointCard({ point, selected }: { point: MapPoint; selected: boolean }) {
  const className = point.excluded ? 'excluded' : point.onEdge ? 'edge' : point.fog ? 'fog' : `st-${point.stage}`;
  const meta = point.excluded ? `不学 · ${point.stageLabel}` : point.reviewCompleted ? '已完成轻量巩固' : point.onEdge ? '下一步可学' : point.fog ? '前置还没学会' : point.nextReviewAt ? `${point.stageLabel} · ${relativeDue(point.nextReviewAt)}复习` : point.stageLabel;
  return (
    <button type="button" className={`point ${className}`} aria-current={selected} onClick={() => navigate({ name: 'map', pointId: point.id })}>
      <span className="p-title">{point.title}</span>
      <span className="p-meta">
        {point.decomposed ? '拆解出的前置 · ' : point.origin === 'asked' ? '提问时加入 · ' : ''}
        {meta}
      </span>
      {!point.excluded && <MasteryBar mastery={point.mastery} />}
    </button>
  );
}

/** 知识点详情：掌握阶段、下次复习、联结、全部作答留档，可重新学习 */
function PointPanel({ pointId, map, onChanged }: { pointId: string; map: CognitiveMap; onChanged: () => void }) {
  const detail = useResource(() => api.point(pointId), [pointId]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [changing, setChanging] = useState(false);
  const point = map.points.find((p) => p.id === pointId);
  const byId = new Map(map.points.map((p) => [p.id, p]));
  const links = map.connections.filter((c) => c.fromPointId === pointId || c.toPointId === pointId);
  const lastLesson = detail.data ? detail.data.records.map((r) => r.kind).lastIndexOf('lesson') : -1;
  const askRef = useRef<AskPanelHandle>(null);

  async function changeLearning() {
    if (!detail.data || changing) return;
    const excluded = !detail.data.excluded;
    setChanging(true);
    setError('');
    setMessage('');
    try {
      await api.setLearningExcluded(pointId, excluded);
      await Promise.all([onChanged(), detail.reload()]);
      setMessage(excluded ? '已设为不学，学习记录保留，后续内容仍可继续学习。' : '已重新加入学习，沿用原有学习进度。');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChanging(false);
    }
  }

  async function relearn() {
    if (!window.confirm('重新学习会把这个知识点退回"理解"阶段：下一节微课堂换一种讲法重讲，答对后复习安排从头开始。确定吗？')) return;
    setError('');
    try {
      await api.relearn([pointId]);
      setMessage('已安排：下一节微课堂会重讲它。');
      onChanged();
      void detail.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
    <SelectionToAsk scope=".point-panel" onQuote={(text) => askRef.current?.quote(text)} />
    <section className="panel white point-panel" aria-labelledby="point-title">
      <a className="back-link" href={routeHash({ name: 'map' })}>
        <Icon name="back" />
        收起
      </a>
      <h2 id="point-title" style={{ fontSize: 18, lineHeight: '26px' }}>
        {point?.title ?? detail.data?.title}
      </h2>
      {detail.data && (
        <>
          <p className="muted small" style={{ marginTop: 4 }}>
            {detail.data.topicTitle}
          </p>
          <div className="actions-row" style={{ marginTop: 12 }}>
            {detail.data.excluded && <span className="pill learning-excluded">不学</span>}
            <span className={`pill ${detail.data.stage === 'unlearned' ? '' : 'accent'}`}>{STAGE_LABEL[detail.data.stage]}</span>
            {detail.data.reviewCompleted && <span className="pill">已完成轻量巩固</span>}
            {detail.data.nextReviewAt && <span className="muted small">下次复习：{relativeDue(detail.data.nextReviewAt)}</span>}
          </div>
          {detail.data.reviewCompleted && <p className="muted small">低档下不再自动复习，学习记录已保留。切回高档或重新学习后会继续巩固。</p>}
          <p style={{ marginTop: 12 }}>{detail.data.summary}</p>
          {point?.prerequisiteIds.length ? (
            <p className="muted small" style={{ marginTop: 8 }}>
              前置：{point.prerequisiteIds.map((id) => `${byId.get(id)?.title ?? ''}${byId.get(id)?.excluded ? '（不学）' : ''}`).join('、')}
            </p>
          ) : null}
          <div className="actions-row">
            <button type="button" className="btn small" onClick={changeLearning} disabled={changing}>
              {changing ? '保存中…' : detail.data.excluded ? '重新加入学习' : '设为不学'}
            </button>
            {detail.data.canRelearn && (
              <button type="button" className="btn small ghost" onClick={relearn} disabled={changing}>
                重新学习
              </button>
            )}
          </div>
          <p className="muted small" style={{ marginTop: 8 }}>
            {detail.data.excluded ? '不再安排新学和复习，随时可以重新加入。' : '不想学这部分？设为不学后保留记录，随时可恢复。'}
          </p>
          {message && <p className="notice ok" style={{ marginTop: 12 }}>{message}</p>}
          {error && <p className="error-text" style={{ marginTop: 12 }}>{error}</p>}

          {links.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <h3 className="small muted" style={{ marginBottom: 8 }}>
                联结
              </h3>
              <div className="rows">
                {links.map((c) => (
                  <div key={c.id} className="row-card" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                    <span className="row-title">
                      {byId.get(c.fromPointId)?.title} ↔ {c.toPointId ? byId.get(c.toPointId)?.title : c.toExisting?.text}
                    </span>
                    <span className="reading" style={{ fontSize: 14 }}>
                      <blockquote style={{ margin: '6px 0 0' }}>{c.quote}</blockquote>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ marginTop: 24 }}>
            <h3 className="small muted" style={{ marginBottom: 4 }}>
              作答留档 · {detail.data.records.length} 次
            </h3>
            {detail.data.records.length === 0 && (
              <p className="muted">还没学过。{detail.data.excluded ? '已设为不学，可随时重新加入学习。' : point?.onEdge ? '下一节微课堂会排入它。' : '前置条件满足后，会排入微课堂。'}</p>
            )}
            {detail.data.records.map((record, i) => (
              <RecordView key={record.attemptId} record={record} label={`第 ${i + 1} 次`} explanationOpen={i === lastLesson} />
            ))}
          </div>
        </>
      )}
      {detail.error && <p className="error-text">{detail.error}</p>}
    </section>
    <AskPanel ref={askRef} scope={{ pointId }} contextTitle={point?.title ?? detail.data?.title ?? ''} />
    </>
  );
}

function Connections({ map }: { map: CognitiveMap }) {
  const byId = new Map(map.points.map((p) => [p.id, p]));
  const shown = map.connections.slice(0, 5);
  return (
    <section className="panel" aria-labelledby="links-title">
      <header>
        <h2 id="links-title">
          联结 <span className="chip">{map.connections.length}</span>
        </h2>
      </header>
      {shown.length === 0 && <p className="muted">每学一个新知识点，会请你用自己的话把它和已经会的联系起来，成立的联结记在这里。</p>}
      <div className="rows">
        {shown.map((c) => (
          <a key={c.id} className="row-card" href={routeHash({ name: 'map', pointId: c.fromPointId })} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <span className="row-title">
              {byId.get(c.fromPointId)?.title} ↔ {c.toPointId ? byId.get(c.toPointId)?.title : c.toExisting?.text}
            </span>
            <span className="row-sub" style={{ whiteSpace: 'normal' }}>
              「{c.quote}」
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}

/** 已有知识：学习之前就会的东西，新知识可以挂靠在上面 */
export function ExistingKnowledge({ map, onChanged }: { map: CognitiveMap; onChanged: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await api.addExistingKnowledge(text);
      setText('');
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(id: string) {
    setError('');
    try {
      await api.removeExistingKnowledge(id);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="panel" aria-labelledby="known-title">
      <header>
        <h2 id="known-title">
          已有知识 <span className="chip">{map.existingKnowledge.length}</span>
        </h2>
      </header>
      {map.existingKnowledge.length === 0 && <p className="muted" style={{ marginBottom: 12 }}>摸底时从你的背景自述里提炼，也可以自己添加。</p>}
      <div className="rows">
        {map.existingKnowledge.map((k) => (
          <div key={k.id} className="row-card" style={{ minHeight: 48 }}>
            <span className="row-main">{k.text}</span>
            <button type="button" className="btn small ghost" onClick={() => remove(k.id)} aria-label={`删除已有知识：${k.text}`}>
              删除
            </button>
          </div>
        ))}
      </div>
      <form className="actions-row" onSubmit={add}>
        <input className="input" style={{ flex: '1 1 140px' }} value={text} maxLength={100} onChange={(e) => setText(e.target.value)} placeholder="例如：会用 Excel 做透视表" aria-label="新的已有知识" />
        <button type="submit" className="btn" disabled={!text.trim()}>
          添加
        </button>
      </form>
      {error && <p className="error-text" style={{ marginTop: 8 }}>{error}</p>}
    </section>
  );
}
