import { useEffect, useRef, useState } from 'react';
import { type FinishResult, type Session, type SessionItem, api } from '../api';
import { AskPanel, type AskPanelHandle } from '../components/AskPanel';
import { SelectionToAsk } from '../components/SelectionToAsk';
import { AnswerArea, type Draft, QuestionStem, canSubmit, initialDraft } from '../components/Questions';
import { ERROR_LABEL, OPTION_LETTERS, PURPOSE_LABEL } from '../labels';
import { RichMarkdown } from '../RichMarkdown';
import { navigate, routeHash } from '../router';

/** 作答结果；联结练习另带 AI 对两者关系的一句话概括 */
type Result = NonNullable<SessionItem['attempt']> & { relation?: string | null };

/**
 * 学习中的一节：一次只展示一项，答完再进入下一项。
 * 进入页面时从服务端恢复未完成的一节和最新学习选择；没有就回到今天。
 */
export function LearnScreen({ initial, onDone }: { initial: { session: Session; notice?: string } | null; onDone: () => void }) {
  const [state, setState] = useState<typeof initial>(null);
  const [error, setError] = useState('');
  const [finished, setFinished] = useState<{ result: FinishResult; session: Session; results: Record<string, Result> } | null>(null);

  useEffect(() => {
    let active = true;
    // 每次进入学习页都读取当前状态，地图里的学习选择也能立即生效
    async function resume() {
      const preview = await api.preview();
      if (!active) return;
      if (!preview.open) return navigate({ name: 'today' });
      const resumed = await api.nextSession();
      if (active && resumed.session) setState({ session: resumed.session, notice: initial?.notice });
    }
    void resume().catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);

  if (finished) return <FinishView {...finished} onLeave={onDone} />;
  if (error) return <p className="error-text">{error}</p>;
  if (!state) return <p className="muted">正在打开这一节…</p>;
  return <SessionFlow session={state.session} notice={state.notice} onFinished={(result, session, results) => setFinished({ result, session, results })} />;
}

function SessionFlow(props: { session: Session; notice?: string; onFinished: (result: FinishResult, session: Session, results: Record<string, Result>) => void }) {
  const { notice, onFinished } = props;
  const [session, setSession] = useState(props.session);
  const [results, setResults] = useState<Record<string, Result>>(() =>
    Object.fromEntries(session.items.filter((i) => i.attempt).map((i) => [i.id, i.attempt!])),
  );
  const firstOpen = session.items.findIndex((i) => !i.excluded && (!i.attempt || i.attempt.needsRating));
  const [index, setIndex] = useState(firstOpen === -1 ? session.items.length - 1 : firstOpen);
  const [finishing, setFinishing] = useState(false);
  const [changing, setChanging] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [error, setError] = useState('');
  const askRef = useRef<AskPanelHandle>(null);
  const item = session.items[index]!;
  const nextIndex = session.items.findIndex((it, i) => i > index && !it.excluded && (!results[it.id] || results[it.id]!.needsRating));
  const isLast = nextIndex === -1;
  const busy = finishing || changing || answering;

  async function changeLearning(pointId: string, excluded: boolean) {
    if (busy) return;
    setChanging(true);
    setError('');
    try {
      await api.setLearningExcluded(pointId, excluded);
      setSession((prev) => ({
        ...prev,
        items: prev.items.map((it) => it.knowledgePointId === pointId ? { ...it, excluded } : it),
      }));
      if (!excluded) {
        const restored = session.items.findIndex((it) => it.knowledgePointId === pointId && (!results[it.id] || results[it.id]!.needsRating));
        if (restored !== -1) setIndex(restored);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChanging(false);
    }
  }

  async function finish() {
    setFinishing(true);
    setError('');
    try {
      onFinished(await api.finish(session.id), session, results);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFinishing(false);
    }
  }

  async function next() {
    if (busy) return;
    if (!isLast) return setIndex(nextIndex);
    await finish();
  }

  async function finishEarly() {
    if (!window.confirm('提前结束这一节？没做的项不计入，下一节会重新安排。')) return;
    await finish();
  }

  return (
    <div className="grid top">
      <SelectionToAsk scope=".learn-article" onQuote={(text) => askRef.current?.quote(text)} />
      <div className="span-8 learn-article">
        <div className="progress-steps" aria-hidden="true">
          {session.items.map((it, i) => (
            <span key={it.id} className={it.excluded ? 'excluded' : i === index ? 'current' : results[it.id] && !results[it.id]!.needsRating ? 'done' : ''} />
          ))}
        </div>
        {notice && index === Math.max(0, firstOpen) && <p className="notice ok" style={{ marginBottom: 16 }}>{notice}</p>}
        {error && <p className="error-text" role="alert" style={{ marginBottom: 16 }}>{error}</p>}
        {item.excluded ? (
          <section className="panel" aria-labelledby="excluded-title">
            <span className="pill learning-excluded">不学</span>
            <h1 id="excluded-title" style={{ marginTop: 12 }}>{item.title}</h1>
            <p className="muted" style={{ marginTop: 12 }}>已停止安排这个知识点的新学和复习，原有学习进度和作答记录保留。</p>
            <div className="actions-row">
              <button type="button" className="btn primary" onClick={next} disabled={busy}>{isLast ? '完成这一节' : '继续下一项'}</button>
              <button type="button" className="btn" onClick={() => changeLearning(item.knowledgePointId, false)} disabled={busy}>重新加入学习</button>
            </div>
          </section>
        ) : <ItemView
          key={item.id}
          sessionId={session.id}
          item={item}
          position={`第 ${index + 1} / ${session.items.length} 项`}
          result={results[item.id] ?? null}
          onResult={(r) => setResults((prev) => ({ ...prev, [item.id]: r }))}
          onNext={next}
          isLast={isLast}
          busy={busy}
          onExclude={() => changeLearning(item.knowledgePointId, true)}
          onWorkingChange={setAnswering}
          onAsk={() => askRef.current?.focus()}
        />}
      </div>
      <aside className="span-4 rail">
        <section className="panel" aria-labelledby="session-list-title">
          <header>
            <h2 id="session-list-title">这一节</h2>
            <span className="meta num">{session.items.filter((it) => !it.excluded).length} 项 · 约 {Math.ceil(session.items.filter((it) => !it.excluded).reduce((s, i) => s + i.estSeconds, 0) / 60)} 分钟</span>
          </header>
          <ol className="rail-list">
            {session.items.map((it, i) => {
              const done = results[it.id] && !results[it.id]!.needsRating;
              return (
                <li key={it.id} className={`rail-item ${i === index ? 'current' : ''} ${done ? 'done' : ''} ${it.excluded ? 'excluded' : ''}`}>
                  <span className="dot" />
                  <span className="ri-title">{it.title}</span>
                  {it.excluded ? <>
                    <span className="pill learning-excluded">不学</span>
                    <button type="button" className="secondary-link restore-learning" onClick={() => changeLearning(it.knowledgePointId, false)} disabled={busy} aria-label={`重新加入学习：${it.title}`}>恢复</button>
                  </> : <span className="small">{PURPOSE_LABEL[it.purpose]}</span>}
                </li>
              );
            })}
          </ol>
          {session.guidance && (
            <p className="muted small" style={{ marginTop: 12 }}>
              补充说明：{session.guidance}
            </p>
          )}
          <div className="actions-row">
            <button type="button" className="btn small ghost" onClick={finishEarly} disabled={busy}>
              提前结束这一节
            </button>
          </div>
        </section>
        {!item.excluded && <AskPanel ref={askRef} scope={{ sessionId: session.id }} itemId={item.id} contextTitle={item.title} />}
      </aside>
    </div>
  );
}

function ItemView(props: {
  sessionId: string;
  item: SessionItem;
  position: string;
  result: Result | null;
  onResult: (result: Result) => void;
  onNext: () => void;
  isLast: boolean;
  busy: boolean;
  onExclude: () => Promise<void>;
  onWorkingChange: (working: boolean) => void;
  /** 打开提问框 */
  onAsk: () => void;
}) {
  const { sessionId, item, position, result, onResult, onNext, isLast, busy, onExclude, onWorkingChange, onAsk } = props;
  const shownAt = useRef(Date.now());
  const [draft, setDraft] = useState<Draft>(() => initialDraft(item.question));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // 分步揭示、预测揭晓：看完讲解才出题
  const [ready, setReady] = useState(!item.steps && !item.predict);
  const titleRef = useRef<HTMLHeadingElement>(null);

  // 换到这一项时回到顶部，焦点落在标题上：注意力从这一项的开头开始
  useEffect(() => {
    window.scrollTo({ top: 0 });
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  // 分步揭示、预测揭晓看完后才出题：题目出现时把答题区带进视线
  const answerRef = useRef<HTMLElement>(null);
  const gated = Boolean(item.steps || item.predict);
  useEffect(() => {
    if (gated && ready) answerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [gated, ready]);

  async function submit() {
    setSubmitting(true);
    onWorkingChange(true);
    setError('');
    try {
      const answer = item.question && (item.question.type === 'mcq' || item.question.type === 'pick_line') ? { choice: draft.choice! } : { text: draft.text };
      const r = await api.submitAttempt({ sessionId, itemId: item.id, answer, durationMs: Date.now() - shownAt.current });
      onResult({
        attemptId: r.attemptId,
        correct: r.correct,
        errorType: r.errorType,
        feedback: r.feedback,
        needsRating: r.needsRating,
        reveal: 'relation' in r.reveal ? null : r.reveal,
        appeal: null,
        voided: false,
        relation: 'relation' in r.reveal ? r.reveal.relation : null,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
      onWorkingChange(false);
    }
  }

  const question = item.question;
  const choiceCount = !result && question ? (question.type === 'mcq' ? question.options.length : question.type === 'pick_line' ? Math.min(9, question.lines.length) : 0) : 0;
  const submittableRef = useRef(false);

  // 键盘：数字键选择，Enter 提交；在输入框里用 ⌘/Ctrl + Enter 提交
  useEffect(() => {
    if (result || !ready || busy) return;
    const onKey = (event: KeyboardEvent) => {
      // 提问框里的按键只属于提问
      if (event.target instanceof HTMLElement && event.target.closest('.ask-panel')) return;
      const typing = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement;
      // 焦点在普通按钮上时，Enter 由按钮自己响应；焦点在刚点过的选项上时，Enter 是提交
      const onOption = event.target instanceof HTMLElement && event.target.closest('.question .options, .question .code-lines') !== null;
      if (event.key === 'Enter' && event.target instanceof HTMLButtonElement && !onOption) return;
      if (event.key === 'Enter' && (!typing || event.metaKey || event.ctrlKey)) {
        if (submittableRef.current && !submitting) {
          event.preventDefault();
          void submit();
        }
        return;
      }
      const n = Number(event.key);
      if (!typing && Number.isInteger(n) && n >= 1 && n <= choiceCount) setDraft((d) => ({ ...d, choice: n - 1 }));
      // 0 是"不知道"
      if (!typing && event.key === '0' && choiceCount > 0) setDraft((d) => ({ ...d, choice: -1 }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const answerIndex = result?.reveal && 'answerIndex' in result.reveal ? (result.reveal.answerIndex ?? null) : null;
  const submittable = item.kind === 'connection' ? draft.text.trim().length > 0 : question ? canSubmit(question, draft) : false;
  submittableRef.current = submittable;

  return (
    <article>
      <header className="item-head">
        <h1 ref={titleRef} tabIndex={-1}>
          {item.kind === 'connection' ? `把「${item.title}」和已经会的联系起来` : item.title}
        </h1>
        <span>{position}</span>
        <span>· {item.topicTitle}</span>
        {item.kind !== 'connection' && <span>· {item.formLabel}</span>}
      </header>
      <p className="task">
        <span className={`pill ${item.purpose === 'new' ? 'accent' : ''}`}>{PURPOSE_LABEL[item.purpose]}</span>
        <span style={{ flex: 1 }}>{taskOf(item)}</span>
        <button type="button" className="secondary-link" style={{ marginTop: 0 }} onClick={onExclude} disabled={busy || submitting}>
          设为不学
        </button>
        <button type="button" className="secondary-link" style={{ marginTop: 0 }} onClick={onAsk}>
          有疑问？问一下
        </button>
      </p>

      {item.explanation && (
        <div className="lesson-block">
          {item.predict ? (
            <Predict predict={item.predict} explanation={item.explanation} onDone={() => setReady(true)} />
          ) : (
            <div className="reading">
              <RichMarkdown>{item.explanation}</RichMarkdown>
            </div>
          )}
          {item.steps && <Steps steps={item.steps} onDone={() => setReady(true)} />}
        </div>
      )}

      {ready && item.connection && (
        <section className="question" aria-labelledby="answer-title" ref={answerRef}>
          <h2 id="answer-title" className="answer-title">
            答题 <span className="muted">用自己的话写，一两句话就够</span>
          </h2>
          <div className="question-stem reading">
            <p>{item.connection.prompt}</p>
          </div>
          <textarea
            className="textarea"
            rows={4}
            value={draft.text}
            disabled={!!result || submitting || busy}
            placeholder="用你自己的话写，一两句话就够"
            aria-label="联结练习的作答"
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          />
        </section>
      )}

      {ready && question && (
        <section className="question" aria-labelledby="answer-title" ref={answerRef}>
          <h2 id="answer-title" className="answer-title">
            答题 <span className="muted">{ANSWER_HINT[question.type]}</span>
          </h2>
          <QuestionStem question={question} />
          <AnswerArea question={question} draft={draft} onChange={setDraft} marks={result ? { answerIndex, chosen: draft.choice } : null} disabled={!!result || submitting || busy} />
        </section>
      )}

      {ready && !result && (
        <div className="actions-row">
          <button type="button" className="btn primary" onClick={submit} disabled={!submittable || submitting || busy}>
            {submitting ? (question?.type === 'mcq' || question?.type === 'pick_line' ? '提交中…' : 'AI 批改中…') : '提交'}
          </button>
          <span className="muted small">{choiceCount > 0 ? `键盘：1–${choiceCount} 选择，0 不知道，Enter 提交` : '⌘/Ctrl + Enter 提交'}</span>
          {error && <span className="error-text">{error}</span>}
        </div>
      )}

      {result && (
        <ResultView item={item} result={result} unknown={draft.choice === -1} onResult={onResult} onNext={onNext} isLast={isLast} busy={busy} onWorkingChange={onWorkingChange} />
      )}
    </article>
  );
}

/** 这一项要做什么：一句话说明任务，放在标题下面 */
const TASK: Record<SessionItem['purpose'], string> = {
  new: '先读讲解，读完答一道小题，检验是否听懂。',
  advance: '上次没答对，这次换一种讲法再讲一遍。',
  contrast: '上次把它和易混的概念搞混了，这次并排对比着讲。',
  review: '隔了一段时间，不看资料，凭记忆回答。',
  spot_check: '摸底时推断你已经会了，答一道题确认一下。',
  connection: '用自己的话把刚学的和已经会的联系起来，成立就记进认知地图。',
};

function taskOf(item: SessionItem): string {
  if (item.steps) return `${TASK[item.purpose]}讲解分 ${item.steps.length} 步，一步步点开，看完再答题。`;
  if (item.predict) return `${TASK[item.purpose]}先预测结果，再看揭晓。`;
  return TASK[item.purpose];
}

const ANSWER_HINT: Record<NonNullable<SessionItem['question']>['type'], string> = {
  mcq: '选出正确的一项',
  pick_line: '点出有错的那一行',
  short_answer: '用自己的话回答',
  complete: '写出 ____ 处缺少的部分',
  fix: '把下面的版本改正确',
};

/** 预测揭晓：先预测，再揭晓答案和讲解；预测不计分 */
function Predict({ predict, explanation, onDone }: { predict: NonNullable<SessionItem['predict']>; explanation: string; onDone: () => void }) {
  const [choice, setChoice] = useState<number | null>(null);
  return (
    <div className="reading">
      <p className="muted small" style={{ margin: '0 0 8px' }}>
        先预测一下，再看揭晓（不计分）
      </p>
      <RichMarkdown>{predict.scenario}</RichMarkdown>
      <div className="options" style={{ margin: '12px 0' }}>
        {predict.options.map((option, i) => (
          <button
            key={i}
            type="button"
            className={`option ${choice === null ? '' : i === predict.answerIndex ? 'correct' : i === choice ? 'wrong' : ''}`}
            aria-pressed={choice === i}
            disabled={choice !== null}
            onClick={() => {
              setChoice(i);
              onDone();
            }}
          >
            <span className="letter">{OPTION_LETTERS[i]}</span>
            <span className="option-text">
              <RichMarkdown>{option}</RichMarkdown>
            </span>
          </button>
        ))}
      </div>
      {choice !== null && (
        <>
          <p>
            <strong>{choice === predict.answerIndex ? '预测对了。' : `答案是 ${OPTION_LETTERS[predict.answerIndex]}。`}</strong> {predict.reveal}
          </p>
          <RichMarkdown>{explanation}</RichMarkdown>
        </>
      )}
    </div>
  );
}

/** 分步揭示：一步一步点开，看完最后一步才出题 */
function Steps({ steps, onDone }: { steps: string[]; onDone: () => void }) {
  const [shown, setShown] = useState(1);
  const all = shown >= steps.length;
  useEffect(() => {
    if (all) onDone();
  }, [all, onDone]);
  return (
    <div className="reading">
      {steps.slice(0, shown).map((step, i) => (
        <div className="step" key={i}>
          <div className="step-count">
            第 {i + 1} 步 / 共 {steps.length} 步
          </div>
          <RichMarkdown>{step}</RichMarkdown>
        </div>
      ))}
      {!all && (
        <div className="actions-row">
          <button type="button" className="btn" onClick={() => setShown(shown + 1)}>
            下一步（{shown + 1} / {steps.length}）
          </button>
        </div>
      )}
    </div>
  );
}

/** 批改结果：判定、反馈、参考答案；答对后自评；判错可申诉 */
function ResultView(props: {
  item: SessionItem;
  result: Result;
  /** 选的是"不知道" */
  unknown: boolean;
  onResult: (r: Result) => void;
  onNext: () => void;
  isLast: boolean;
  busy: boolean;
  onWorkingChange: (working: boolean) => void;
}) {
  const { item, result, unknown, onResult, onNext, isLast, busy, onWorkingChange } = props;
  const [appealing, setAppealing] = useState(false);
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const relation = result.relation;

  async function rate(selfRating: 'hard' | 'good' | 'easy') {
    if (busy) return;
    onWorkingChange(true);
    setError('');
    try {
      await api.rate(result.attemptId, selfRating);
      onResult({ ...result, needsRating: false });
      onNext();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      onWorkingChange(false);
    }
  }

  async function appeal() {
    setSending(true);
    onWorkingChange(true);
    setError('');
    try {
      const r = await api.appeal(result.attemptId, reason);
      onResult({
        ...result,
        correct: r.outcome === 'accepted' ? true : result.correct,
        needsRating: r.needsRating,
        voided: r.outcome === 'void',
        appeal: { reason, outcome: r.outcome, feedback: r.feedback, at: new Date().toISOString() },
      });
      setAppealing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
      onWorkingChange(false);
    }
  }

  const isConnection = item.kind === 'connection';
  const verdict = isConnection
    ? result.correct
      ? '这条联结成立，已记入认知地图'
      : '这条联结还不成立，没有记入认知地图'
    : result.voided
      ? '这道题已作废，不计入记忆'
      : result.correct
        ? '答对了'
        : unknown
          ? '不知道也没关系，看看解析'
          : `答错了 · ${result.errorType ? ERROR_LABEL[result.errorType] : ''}`;

  // 结果出现时滚进视线，注意力落在判定上
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    resultRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
  }, []);

  // 键盘：1/2/3 自评，Enter 下一项
  useEffect(() => {
    if (appealing || busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
      // 焦点在按钮上时，Enter 由按钮自己响应，不再重复处理
      if (event.key === 'Enter' && event.target instanceof HTMLButtonElement) return;
      if (result.needsRating) {
        const rating = ({ '1': 'hard', '2': 'good', '3': 'easy' } as const)[event.key as '1' | '2' | '3'];
        if (rating) void rate(rating);
      } else if (event.key === 'Enter' && !busy) {
        event.preventDefault();
        onNext();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="result" role="status" ref={resultRef}>
      <div className={`result-verdict ${result.correct ? 'ok' : result.voided || unknown ? '' : 'bad'}`}>{verdict}</div>
      {result.feedback && (
        <div className="reading" style={{ fontSize: 15 }}>
          <RichMarkdown>{result.feedback}</RichMarkdown>
        </div>
      )}
      {relation && <p className="muted" style={{ marginTop: 8 }}>两者的关系：{relation}</p>}
      {result.reveal && 'referenceAnswer' in result.reveal && result.reveal.referenceAnswer && (
        <details open={!result.correct}>
          <summary>参考答案（只作对照，不是唯一标准）</summary>
          <pre className="code-block" style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>
            {result.reveal.referenceAnswer}
          </pre>
        </details>
      )}
      {result.appeal && (
        <p style={{ marginTop: 10 }}>
          <span className="pill">{{ accepted: '申诉成立', void: '题目作废', rejected: '维持原判' }[result.appeal.outcome]}</span>{' '}
          <span className="muted">{result.appeal.feedback}</span>
        </p>
      )}

      {!appealing &&
        (result.needsRating ? (
          <div className="rating">
            <span>回答起来感觉：</span>
            <button type="button" className="btn" onClick={() => rate('hard')} disabled={busy}>
              困难
            </button>
            <button type="button" className="btn" onClick={() => rate('good')} disabled={busy}>
              良好
            </button>
            <button type="button" className="btn" onClick={() => rate('easy')} disabled={busy}>
              轻松
            </button>
            <span className="muted small">影响后续复习安排 · 键盘 1 / 2 / 3</span>
          </div>
        ) : (
          <div className="actions-row">
            <button type="button" className="btn primary" onClick={onNext} disabled={busy}>
              {isLast ? '完成这一节' : '下一项'}
            </button>
            <span className="muted small">Enter</span>
          </div>
        ))}

      {appealing && (
        <div className="stack" style={{ marginTop: 14 }}>
          <label className="field">
            <span className="label">为什么你的答案也对，或者题目哪里有问题？</span>
            <textarea className="textarea" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} autoFocus />
          </label>
          <div className="actions-row" style={{ marginTop: 0 }}>
            <button type="button" className="btn primary" onClick={appeal} disabled={!reason.trim() || sending}>
              {sending ? 'AI 重新判定中…' : '提交申诉'}
            </button>
            <button type="button" className="btn ghost" onClick={() => setAppealing(false)} disabled={sending}>
              取消
            </button>
          </div>
        </div>
      )}

      {error && <p className="error-text" role="alert">{error}</p>}

      {!isConnection && !unknown && !result.correct && !result.voided && !result.appeal && !appealing && (
        <button type="button" className="secondary-link" onClick={() => setAppealing(true)} disabled={busy}>
          觉得判错了？申诉
        </button>
      )}
    </div>
  );
}

/** 这一节完成：小结，以及到期时的主题回访 */
function FinishView(props: { result: FinishResult; session: Session; results: Record<string, Result>; onLeave: () => void }) {
  const { result, session, results, onLeave } = props;
  const graded = session.items.filter((i) => i.kind !== 'connection' && results[i.id] && !results[i.id]!.voided);
  const correct = graded.filter((i) => results[i.id]!.correct).length;
  const links = session.items.filter((i) => i.kind === 'connection' && results[i.id]?.correct).length;
  const [revisitDone, setRevisitDone] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);

  async function answerRevisit(ids: string[]) {
    await api.answerRevisit(ids);
    setRevisitDone(true);
  }

  return (
    <div className="grid top">
      <section className="span-8">
        <h1 className="greeting" style={{ fontSize: 36 }}>
          这一节学完了。
        </h1>
        <p className="greeting-sub">
          答对 {correct} / {graded.length} 项{links > 0 ? `，新建了 ${links} 条联结` : ''}。下一节正在后台准备，到时打开即可。
        </p>
        <div className="rows" style={{ marginTop: 24 }}>
          {session.items.map((item) => {
            const r = results[item.id];
            const text = !r ? (item.excluded ? '不学' : '没做') : r.voided ? '作废' : item.kind === 'connection' ? (r.correct ? '联结成立' : '联结不成立') : r.correct ? '答对' : '答错';
            return (
              <a key={item.id} className="row-card" href={routeHash({ name: 'map', pointId: item.knowledgePointId })}>
                <span className="pill">{PURPOSE_LABEL[item.purpose]}</span>
                <span className="row-main">
                  <span className="row-title">{item.title}</span>
                  <span className="row-sub">{item.formLabel}</span>
                </span>
                {item.excluded && r && <span className="pill learning-excluded">不学</span>}
                <span className={`pill ${!r ? (item.excluded ? 'learning-excluded' : '') : r.correct ? 'pos' : r.voided ? '' : 'neg'}`}>{text}</span>
              </a>
            );
          })}
        </div>
        <div className="actions-row" style={{ marginTop: 24 }}>
          <a
            className="btn primary"
            href={routeHash({ name: 'today' })}
            onClick={() => {
              onLeave();
            }}
          >
            回到今天
          </a>
          <a className="btn" href={routeHash({ name: 'map' })} onClick={onLeave}>
            看认知地图
          </a>
        </div>
      </section>
      {result.revisit && !revisitDone && (
        <aside className="span-4 panel" aria-labelledby="revisit-title">
          <header>
            <h2 id="revisit-title">暂停的主题，想恢复哪些？</h2>
          </header>
          <p className="muted" style={{ marginBottom: 8 }}>
            选中的主题恢复新学；不选也没关系，过两周再问你。
          </p>
          {result.revisit.topics.map((t) => (
            <label key={t.id} className="check">
              <input type="checkbox" checked={picked.includes(t.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, t.id] : picked.filter((id) => id !== t.id))} />
              <span>{t.title}</span>
            </label>
          ))}
          <div className="actions-row">
            <button type="button" className="btn" disabled={picked.length === 0} onClick={() => answerRevisit(picked)}>
              恢复选中的主题
            </button>
            <button type="button" className="btn ghost" onClick={() => answerRevisit([])}>
              暂时都不
            </button>
          </div>
        </aside>
      )}
    </div>
  );
}
