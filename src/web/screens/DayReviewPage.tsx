import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { AskPanel, type AskPanelHandle } from '../components/AskPanel';
import { Icon, Mark } from '../components/Icon';
import { RecordView } from '../components/RecordView';
import { SelectionToAsk } from '../components/SelectionToAsk';
import { useResource } from '../hooks';
import { STAGE_LABEL, formatDay } from '../labels';
import { routeHash } from '../router';

const LEARNED = new Set(['inferred', 'recall', 'apply', 'retain']);

/** 按天回看：按当时的顺序重读那一天的讲解和题目；读完可把已学会的安排重新学习。 */
export function DayReviewPage({ day, topicId }: { day: string; topicId?: string }) {
  const review = useResource(() => api.dayReview(day, topicId), [day, topicId]);
  const [message, setMessage] = useState('');
  // 提问围绕哪个知识点：选中内容所在的那条记录的知识点，默认第一个
  const [askPointId, setAskPointId] = useState<string | null>(null);
  const askRef = useRef<AskPanelHandle>(null);
  const [error, setError] = useState('');

  // 标签页标题写明回看哪一天
  useEffect(() => {
    const original = document.title;
    document.title = `回看 ${formatDay(day)} · 微课堂`;
    return () => {
      document.title = original;
    };
  }, [day]);

  const data = review.data;
  const points = data ? [...new Map(data.entries.map((e) => [e.point.id, e.point])).values()] : [];
  const learned = points.filter((p) => LEARNED.has(p.stage));
  const allTopics = data?.topic === null;

  async function relearn() {
    if (!window.confirm('重新学习会把这些知识点退回"理解"阶段：下一节微课堂换一种讲法重讲，答对后复习安排从头开始。确定吗？')) return;
    setError('');
    try {
      const { relearned } = await api.relearn(learned.map((p) => p.id));
      setMessage(`已安排：下一节微课堂会重讲 ${relearned.length} 个知识点。`);
      void review.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div style={{ minHeight: '100svh', background: 'var(--ground)' }}>
      <header className="plain-top">
        <a className="brand" href={routeHash({ name: 'home' })} aria-label="微课堂首页">
          <Mark />
          <span>微课堂</span>
        </a>
      </header>
      <main className="plain-sheet">
        <a className="back-link" href={routeHash({ name: 'history', topicId })}><Icon name="back" />返回历史课程</a>
        <div className="title-row">
          <div>
            <h1>{formatDay(day)}的回看</h1>
            <p className="sub">{data ? `${data.topic?.title ?? '全部主题'} · 学过 ${points.length} 个知识点 · ${data.entries.length} 次作答` : '正在读取…'}</p>
          </div>
        </div>
        {review.error && <p className="error-text">{review.error}</p>}
        {data && data.entries.length === 0 && <div className="empty">这一天没有学习记录。</div>}
        {data && data.entries.length > 0 && (
          <div className="grid top">
            <SelectionToAsk
              scope=".day-records"
              onQuote={(text, from) => {
                const id = from.closest<HTMLElement>('[data-point-id]')?.dataset.pointId;
                if (id) setAskPointId(id);
                askRef.current?.quote(text);
              }}
            />
            <article className="span-8 day-records">
              {data.entries.map(({ topicTitle, point, record }) => (
                <div key={record.attemptId} data-point-id={point.id}>
                  <RecordView record={record} label={allTopics ? `${topicTitle} · ${point.title}` : point.title} explanationOpen />
                </div>
              ))}
            </article>
            <aside className="span-4 rail">
              <section className="panel" aria-labelledby="day-points">
                <header>
                  <h2 id="day-points">
                    这一天的知识点 <span className="chip">{points.length}</span>
                  </h2>
                </header>
                <div className="rows">
                  {points.map((p) => (
                    <a key={p.id} className="row-card" style={{ minHeight: 48 }} href={routeHash({ name: 'map', pointId: p.id })}>
                      <span className="row-main row-title">{p.title}</span>
                      <span className="pill">{STAGE_LABEL[p.stage]}</span>
                    </a>
                  ))}
                </div>
                {learned.length > 0 ? (
                  <div className="actions-row">
                    <button type="button" className="btn" onClick={relearn}>
                      读完还没把握？重新学习其中已学会的 {learned.length} 个
                    </button>
                  </div>
                ) : (
                  <p className="muted" style={{ marginTop: 12 }}>
                    这些知识点都还没学会，下一节微课堂本来就会重讲。
                  </p>
                )}
                {message && <p className="notice ok" style={{ marginTop: 12 }}>{message}</p>}
                {error && <p className="error-text" style={{ marginTop: 12 }}>{error}</p>}
              </section>
              {points.length > 0 && (
                <AskPanel
                  ref={askRef}
                  scope={{ pointId: askPointId ?? points[0]!.id }}
                  contextTitle={points.find((p) => p.id === (askPointId ?? points[0]!.id))?.title ?? ''}
                />
              )}
            </aside>
          </div>
        )}
      </main>
    </div>
  );
}
