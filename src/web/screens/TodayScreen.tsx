import { useCallback, useState } from 'react';
import { type Preview, type ReviewDay, type Session, type Today, type Topic, api } from '../api';
import { Icon } from '../components/Icon';
import { SessionContents, useSessionStart } from '../components/SessionPreview';
import { usePolling, useResource } from '../hooks';
import { formatDay } from '../labels';
import { openReview, routeHash } from '../router';

/** 当天的学习安排与记录；主题探索由独立首页承载。 */
export function TodayScreen(props: { topics: Topic[] | null; onTopicsChanged: () => void; onStart: (session: Session, notice?: string) => void }) {
  const { topics, onTopicsChanged, onStart } = props;
  const preview = useResource(() => api.preview(), []);
  const today = useResource(() => api.today(), []);
  const days = useResource(() => api.reviewDays().then((r) => r.days), []);
  const reloadPreview = preview.reload;
  const refreshAll = useCallback(() => {
    void reloadPreview();
    onTopicsChanged();
  }, [reloadPreview, onTopicsChanged]);
  const generating = (topics ?? []).some((t) => t.graphStatus === 'pending' || t.placementStatus === 'preparing') || preview.data?.preparing === true;
  usePolling(generating, refreshAll);
  const hasTopics = (topics ?? []).length > 0;

  return (
    <>
      <div className="title-row">
        <div>
          <h1>今天的学习</h1>
          <p className="sub">{today.data ? `${formatDay(today.data.date)} · 已完成 ${today.data.sessionsToday} 节${today.data.dailySessionCap !== null ? ` · 每日上限 ${today.data.dailySessionCap} 节` : ''}` : '查看当天的学习安排和记录。'}</p>
        </div>
        <a className="card-link" href={routeHash({ name: 'home' })}>去首页添加新主题<Icon name="chevron" /></a>
      </div>
      {preview.error ? <p className="error-text" role="alert">没能读取下一节：{preview.error} <button className="card-link" type="button" onClick={preview.reload}>重新加载</button></p>
        : <ActionArea preview={preview.data} hasTopics={hasTopics} topics={topics} onStart={onStart} />}
      <div className="grid top section-gap">
        <section className="panel span-8" aria-labelledby="next-title">
          {preview.error ? <><header><h2 id="next-title">这一节会学什么</h2></header><p className="muted">重新加载后查看当前安排。</p></> : <NextContents preview={preview.data} />}
        </section>
        <section className="panel span-4" aria-labelledby="slots-title">
          {today.error ? <><header><h2 id="slots-title">今天的提醒</h2></header><p className="error-text" role="alert">{today.error} <button type="button" className="card-link" onClick={today.reload}>重新加载</button></p></> : <Reminders today={today.data} />}
        </section>
      </div>
      <div className="grid top" style={{ marginTop: 16 }}>
        <section className="panel span-8" aria-labelledby="today-records-title"><DailyRecords day={today.data?.date} dateError={today.error} /></section>
        <section className="panel span-4" aria-labelledby="days-title">
          {days.error ? <><header><h2 id="days-title">历史课程</h2></header><p className="error-text" role="alert">{days.error} <button type="button" className="card-link" onClick={days.reload}>重新加载</button></p></> : <Days days={days.data} />}
        </section>
      </div>
    </>
  );
}

const GUIDANCE_PRESETS = [
  { label: '讲得更浅显', text: '讲得更浅显：少用术语，多用生活中的类比和例子。' },
  { label: '多结合实际场景', text: '多结合实际工作中会遇到的真实场景来举例和出题。' },
  { label: '多用图解释', text: '每段讲解都配图，用图把机制讲清楚。' },
  { label: '讲得更深入', text: '讲得更深入：多讲背后的原理、边界情况和常见的坑。' },
];

/**
 * 当天的学习操作：保留开始、继续与手动构建新一节。
 * 有未完成的一节 → 继续；内容已备好 → 开始；没备好 → 现在构建。"构建新一节"是次要操作，
 * 点开后在原地展开说明框，主按钮换成"构建"，避免两个主按钮抢注意力。
 */
function ActionArea(props: {
  preview: Preview | null;
  hasTopics: boolean;
  topics: Topic[] | null;
  onStart: (session: Session, notice?: string) => void;
}) {
  const { preview, hasTopics, topics, onStart } = props;
  const [composing, setComposing] = useState(false);
  const { busy, error, run } = useSessionStart(onStart);

  if (topics && !hasTopics) {
    return (
      <div className="action-area">
        <p className="muted">还没有学习主题。先到首页添加一个想学的主题，再完成摸底。</p>
        <a className="btn primary" href={routeHash({ name: 'home' })} style={{ marginTop: 12 }}>去首页添加主题</a>
      </div>
    );
  }
  if (!preview) return <div className="action-area"><span className="skeleton" style={{ display: 'inline-block', width: 160, height: 38 }} /></div>;

  if (composing) {
    return <Composer open={preview.open} busy={busy === 'build'} error={error} onBuild={(guidance) => run('build', guidance)} onCancel={() => setComposing(false)} />;
  }

  const remaining = preview.open ? preview.open.items.filter((i) => !i.done).length : 0;
  const ready = preview.items.length > 0;

  return (
    <div className="action-area">
      {preview.capped && !preview.open ? (
        <p className="muted">
          今天已学满 {preview.dailySessionCap} 节。想多学可以在<a className="card-link" href={routeHash({ name: 'settings' })}>设置</a>里调高每日上限。
        </p>
      ) : (
        <div className="actions-row" style={{ marginTop: 0 }}>
          {preview.open ? (
            <button type="button" className="btn primary large" onClick={() => run('start')} disabled={busy !== null}>
              {busy === 'start' ? '正在打开…' : `继续这一节 · 还剩 ${remaining} 项`}
            </button>
          ) : ready ? (
            <button type="button" className="btn primary large" onClick={() => run('start')} disabled={busy !== null}>
              {busy === 'start' ? '正在打开…' : `开始这一节 · 约 ${preview.estMinutes} 分钟`}
            </button>
          ) : (
            <button type="button" className="btn primary large" onClick={() => run('build')} disabled={busy !== null}>
              {busy === 'build' ? '正在构建，大约半分钟…' : '现在构建一节'}
            </button>
          )}
          <button type="button" className="btn large" onClick={() => setComposing(true)} disabled={busy !== null}>
            构建新一节…
          </button>
        </div>
      )}
      {(!preview.capped || preview.open) && <p className="muted small" style={{ marginTop: 10 }}>
        {preview.open
          ? '"构建新一节"会提前结束上一节，没做的项之后重新安排。'
          : ready
            ? '想换个讲法或侧重点？用"构建新一节"写一句说明，按你的说明重新生成。'
            : '构建会当场生成这一节的内容，大约需要半分钟到一分钟。'}
      </p>}
      {error && <p className="error-text" style={{ marginTop: 8 }}>{error}</p>}
    </div>
  );
}

/** 构建新一节：写一句说明引导内容（可选），常用说明一键填入后还能改 */
function Composer(props: { open: Preview['open']; busy: boolean; error: string; onBuild: (guidance?: string) => void; onCancel: () => void }) {
  const { open, busy, error, onBuild, onCancel } = props;
  const [text, setText] = useState('');
  const guidance = text.trim();
  return (
    <section className="panel white action-area composer" aria-labelledby="composer-title">
      <header>
        <h2 id="composer-title">构建新一节</h2>
        <button type="button" className="btn small ghost" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </header>
      <div className="field">
        <label htmlFor="composer-text">想让这一节怎么讲？（可选）</label>
        <span className="hint">知识点按复习和学习进度挑选，说明只改变讲法、例子和出题的角度。</span>
        <div className="time-chips" style={{ margin: '4px 0' }}>
          {GUIDANCE_PRESETS.map((p) => (
            <button key={p.label} type="button" className={`btn small ${text === p.text ? 'selected' : ''}`} aria-pressed={text === p.text} onClick={() => setText(text === p.text ? '' : p.text)} disabled={busy}>
              {p.label}
            </button>
          ))}
        </div>
        <textarea
          id="composer-text"
          autoFocus
          className="textarea"
          rows={3}
          maxLength={500}
          value={text}
          disabled={busy}
          placeholder="例如：我是后端开发，多用 Node.js 的例子"
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {open && <p className="notice" style={{ marginTop: 12 }}>上一节还有 {open.items.filter((i) => !i.done).length} 项没做，构建后上一节提前结束，没做的之后重新安排。</p>}
      <div className="actions-row">
        <button type="button" className="btn primary large" onClick={() => onBuild(guidance || undefined)} disabled={busy}>
          {busy ? (guidance ? '正在按说明生成，大约半分钟到一分钟…' : '正在构建…') : guidance ? '按说明构建' : '直接构建'}
        </button>
      </div>
      {error && <p className="error-text" style={{ marginTop: 8 }}>{error}</p>}
    </section>
  );
}

/** 这一节会学什么：开始前的依据；有未完成的一节时显示它的进度 */
function NextContents({ preview }: { preview: Preview | null }) {
  return (
    <>
      <header>
        <h2 id="next-title">
          {preview?.open ? '上一节的进度' : preview?.capped ? '今天已达到学习上限' : '这一节会学什么'}
          {preview && !preview.open && !preview.capped && preview.items.length > 0 && <span className="chip">约 {preview.estMinutes} 分钟</span>}
        </h2>
        {preview && !preview.open && !preview.capped && <span className="meta">时长上限 {preview.budgetMinutes} 分钟</span>}
        {preview?.open && <span className="meta num">已做 {preview.open.items.filter((i) => i.done && !i.excluded).length} / {preview.open.items.filter((i) => !i.excluded).length}</span>}
      </header>
      <SessionContents preview={preview && preview.capped && !preview.open ? { ...preview, items: [] } : preview} />
    </>
  );
}

function Reminders({ today }: { today: Today | null }) {
  return (
    <>
      <header>
        <h2 id="slots-title">今天的提醒</h2>
        <a className="card-link" href={routeHash({ name: 'settings' })}>
          设置
          <Icon name="chevron" />
        </a>
      </header>
      {!today && <span className="skeleton line" style={{ display: 'block', width: '60%' }} />}
      {today && today.slots.length === 0 && <div className="empty">还没有设提醒时段</div>}
      {today && today.slots.length > 0 && (
        <div className="rows">
          {today.slots.map((slot) => (
            <div key={slot.time} className="row-card" style={{ minHeight: 48 }}>
              <span className="row-main num" style={{ fontSize: 16 }}>
                {slot.time}
              </span>
              <span className={`pill ${slot.done ? 'pos' : ''}`}>{slot.done ? '已学完' : slot.time <= today.now ? '没赶上' : '待学'}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** 今天的记录按服务端返回的业务日期读取，保留按天回看的完整内容入口。 */
function DailyRecords({ day, dateError }: { day?: string; dateError: string }) {
  const review = useResource(() => day ? api.dayReview(day) : Promise.resolve(null), [day]);
  const entries = review.data?.entries ?? [];
  const shown = entries.slice(-5).reverse();
  const pointCount = new Set(entries.map(entry => entry.point.id)).size;

  return (
    <>
      <header><h2 id="today-records-title">今天的学习记录</h2>{day && entries.length > 0 && <button type="button" className="card-link" onClick={() => openReview(day)}>完整回看<Icon name="external" /></button>}</header>
      {review.error ? <p className="error-text" role="alert">没能读取今天的记录：{review.error} <button type="button" className="card-link" onClick={review.reload}>重新加载</button></p>
        : !day && dateError ? <p className="muted">重新加载今天的安排后，即可读取当天的学习记录。</p>
          : !day || !review.data ? <p className="muted">正在读取今天的记录…</p>
          : entries.length === 0 ? <p className="muted">今天还没有学习记录，完成作答后会显示在这里。</p>
            : <>
              <p className="muted small" style={{ marginBottom: 12 }}>学过 {pointCount} 个知识点 · {entries.length} 次作答</p>
              <div className="rows">{shown.map(({ point, topicTitle, record }) => (
                <div key={record.attemptId} className="row-card">
                  <span className="row-main"><span className="row-title">{point.title}</span><span className="row-sub">{topicTitle}</span></span>
                  <time className="row-end small" dateTime={record.at}>{new Date(record.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
                </div>
              ))}</div>
              {entries.length > shown.length && <p className="muted small" style={{ marginTop: 10 }}>最近 {shown.length} 次作答，完整回看中可查看全部记录。</p>}
            </>}
    </>
  );
}

function Days({ days }: { days: ReviewDay[] | null }) {
  const recent = days?.slice(0, 5) ?? [];
  const older = days?.slice(5) ?? [];
  return (
    <>
      <header>
        <h2 id="days-title">历史课程</h2>
        <a className="card-link" href={routeHash({ name: 'history' })}>查看全部<Icon name="chevron" /></a>
      </header>
      {days && days.length === 0 && <div className="empty">学完第一节后，这里可以按天重读当时的讲解。</div>}
      <div className="rows">
        {recent.map((d) => (
          <button key={d.day} type="button" className="row-card" onClick={() => openReview(d.day)}>
            <span className="row-main">
              <span className="row-title">{formatDay(d.day)}</span>
            </span>
            <span className="row-end">
              {d.pointCount} 个知识点
              <Icon name="external" />
            </span>
          </button>
        ))}
      </div>
      {older.length > 0 && (
        <select className="select" style={{ marginTop: 12 }} defaultValue="" aria-label="更早的日期" onChange={(e) => e.target.value && openReview(e.target.value)}>
          <option value="">更早的日期…</option>
          {older.map((d) => (
            <option key={d.day} value={d.day}>
              {formatDay(d.day)}（{d.pointCount} 个知识点）
            </option>
          ))}
        </select>
      )}
    </>
  );
}
