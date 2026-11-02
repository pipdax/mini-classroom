import { type Topic, api } from '../api';
import { Icon } from '../components/Icon';
import { useResource } from '../hooks';
import { formatDay } from '../labels';
import { navigate, routeHash } from '../router';

/** 历史课程按学习日期汇总，保留主题筛选后进入当时的完整记录。 */
export function HistoryScreen({ topicId, topics, topicsError, onTopicsChanged }: {
  topicId?: string;
  topics: Topic[] | null;
  topicsError: string;
  onTopicsChanged: () => void;
}) {
  const days = useResource(() => api.reviewDays(topicId).then(result => result.days), [topicId]);

  return (
    <>
      <div className="title-row">
        <div>
          <h1>历史课程</h1>
          <p className="sub">按学习日期回看当时的讲解、题目和作答记录，最近学过的排在前面。</p>
        </div>
        <a className="btn" href={routeHash({ name: 'today' })}>继续今天的学习<Icon name="chevron" /></a>
      </div>
      <section className="panel" aria-labelledby="history-records-title">
        <header className="history-toolbar">
          <h2 id="history-records-title">按天回看{!days.loading && !days.error && days.data && <span className="chip">{days.data.length} 天</span>}</h2>
          <label className="history-filter">
            <span>学习主题</span>
            <select className="select" value={topicId ?? ''} disabled={!topics || Boolean(topicsError)} onChange={event => navigate({ name: 'history', topicId: event.target.value || undefined })}>
              <option value="">全部主题</option>
              {topicId && !topics?.some(topic => topic.id === topicId) && <option value={topicId}>当前主题</option>}
              {(topics ?? []).map(topic => <option key={topic.id} value={topic.id}>{topic.title}</option>)}
            </select>
          </label>
        </header>
        {topicsError && <p className="error-text" role="alert">没能读取学习主题：{topicsError} <button type="button" className="card-link" onClick={onTopicsChanged}>重新加载主题</button></p>}
        {days.loading ? <p className="muted" role="status">正在读取历史课程…</p>
          : days.error ? <p className="error-text" role="alert">没能读取历史课程：{days.error} <button type="button" className="card-link" onClick={days.reload}>重新加载</button></p>
            : days.data?.length === 0 ? <div className="empty">{topicId ? '这个主题还没有学习记录。' : '还没有历史课程。'}完成作答后，就能在这里回看讲解和题目。</div>
              : <div className="rows">
                {(days.data ?? []).map(day => (
                  <a key={day.day} className="row-card history-day" href={routeHash({ name: 'review', day: day.day, topicId })}>
                    <span className="row-main">
                      <time className="row-title" dateTime={day.day}>{day.day.slice(0, 4)}年{formatDay(day.day)}</time>
                      <span className="row-sub">学过 {day.pointCount} 个知识点</span>
                    </span>
                    <span className="row-end">查看课程<Icon name="chevron" /></span>
                  </a>
                ))}
              </div>}
      </section>
    </>
  );
}
