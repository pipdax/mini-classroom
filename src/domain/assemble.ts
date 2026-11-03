import { type GraphPoint, cognitiveEdge, prerequisitesSatisfied } from './edge';
import { CONTRAST_FORM, isMobileForm } from './forms';
import { type MemoryState, UNLEARNED, isDue, retrievability } from './memory';
import type { ReviewIntensity } from './review';

/** 候选池中的一项内容（组装只关心这些字段） */
export interface PoolItem {
  id: string;
  knowledgePointId: string;
  kind: 'lesson' | 'review';
  /** lesson 为讲解形式，review 为题目形式 */
  form: string;
  /** 题目形式：lesson 是当场小题的形式，review 与 form 相同 */
  questionForm: string;
  estSeconds: number;
}

export interface AssembleInput {
  reviewIntensity?: ReviewIntensity;
  points: GraphPoint[];
  states: Map<string, MemoryState>;
  pool: PoolItem[];
  now: Date;
  budgetSeconds: number;
  maxNewPerSession: number;
  /** 这一节的新知识点来自哪个主题；不传时不限主题 */
  newTopicId?: string | null;
  /** 在手机上打开：只挑适合手机的形式 */
  mobile?: boolean;
  /** 时长校准系数：预估时长 × 系数 ≈ 实际用时。缺省为 1 */
  timeFactor?: number;
}

export interface AssembleResult {
  items: PoolItem[];
  /** 是否因复习积压而暂停新学 */
  newPaused: boolean;
}

/** 到期复习超过这么多节的量，就视为复习积压 */
export const BACKLOG_SESSIONS = 3;
/** 每节最多抽查几个推断掌握的知识点 */
export const MAX_SPOT_CHECKS = 2;
/** 到期知识点在候选池里没有内容时，按这个时长估算积压 */
const DEFAULT_REVIEW_SECONDS = 60;

/**
 * 按组装规则从候选池挑出一节微课堂：
 * 1. 到期复习按可提取性从低到高（最容易忘的在前）；上次答错属于误解的，改排对比讲解；
 * 2. 再抽查推断掌握的知识点，每节最多 MAX_SPOT_CHECKS 个；
 * 3. 再放推进项（理解阶段的重讲，前置还没学会的先不讲）；
 * 4. 再放新知识点，只取一个主题，保底 1 个；复习积压时暂停新学；
 * 5. 几类内容穿插排列；同一知识点优先选与上次不同的形式；手机上只选适合手机的形式。
 */
export function assemble(input: AssembleInput): AssembleResult {
  const { points, states, pool, now, budgetSeconds, maxNewPerSession, newTopicId, mobile = false, timeFactor = 1, reviewIntensity = 'high' } = input;
  const stateOf = (id: string) => states.get(id) ?? UNLEARNED;
  const included = points.filter((p) => !p.excluded);
  const excludedIds = new Set(points.filter((p) => p.excluded).map((p) => p.id));
  const byPosition = new Map(points.map((p) => [p.id, p.position]));
  const usable = pool.filter((item) => (reviewIntensity !== 'low' || item.questionForm === 'mcq') && (!mobile || isMobileForm(item.questionForm)));
  const seconds = (item: PoolItem) => item.estSeconds * timeFactor;
  const pick = (pointId: string, kind: PoolItem['kind'], lastForm: string | null) =>
    pickItem(usable, pointId, kind, lastForm, mobile);

  // 1. 到期复习
  const dueStates = included
    .filter((p) => isDue(stateOf(p.id), now, reviewIntensity))
    .map((p) => ({ id: p.id, state: stateOf(p.id) }))
    .sort((a, b) => retrievability(a.state.card!, now) - retrievability(b.state.card!, now));
  const reviews: PoolItem[] = [];
  let dueSeconds = 0;
  for (const { id, state } of dueStates) {
    const contrast = state.pendingContrast ? findForm(usable, id, CONTRAST_FORM) : undefined;
    const item = contrast ?? pick(id, 'review', state.lastQuestionForm);
    dueSeconds += item ? seconds(item) : DEFAULT_REVIEW_SECONDS;
    if (item) reviews.push(item);
  }

  // 2. 抽查推断掌握的知识点
  const spotChecks = included
    .filter((p) => stateOf(p.id).stage === 'inferred')
    .sort((a, b) => a.position - b.position)
    .map((p) => pick(p.id, 'review', null))
    .filter((item): item is PoolItem => item !== undefined)
    .slice(0, MAX_SPOT_CHECKS);

  // 3. 推进项：理解阶段的知识点，用与上次不同的讲解形式重讲；误解后用对比讲解
  const stageOf = (id: string) => stateOf(id).stage;
  const advances = included
    .filter((p) => stageOf(p.id) === 'understand' && prerequisitesSatisfied(p, stageOf, excludedIds))
    .sort((a, b) => a.position - b.position)
    .map((p) => {
      const state = stateOf(p.id);
      const contrast = state.pendingContrast ? findForm(usable, p.id, CONTRAST_FORM) : undefined;
      return contrast ?? pick(p.id, 'lesson', state.lastExplainForm);
    })
    .filter((item): item is PoolItem => item !== undefined);

  // 4. 新知识点：来自认知边缘，只取这一节选定的主题
  const newPaused = dueSeconds > BACKLOG_SESSIONS * budgetSeconds;
  const news = newPaused
    ? []
    : cognitiveEdge(points, states)
        .filter((p) => newTopicId === undefined || newTopicId === null || p.topicId === newTopicId)
        .map((p) => pick(p.id, 'lesson', null))
        .filter((item): item is PoolItem => item !== undefined)
        .slice(0, maxNewPerSession);

  // 先为保底的新知识点预留时间，再依次填充
  const guaranteed = news[0];
  let remaining = budgetSeconds - (guaranteed ? seconds(guaranteed) : 0);
  const takenReviews = takeWithin(reviews, remaining, seconds);
  remaining -= sum(takenReviews, seconds);
  const takenSpotChecks = takeWithin(spotChecks, remaining, seconds);
  remaining -= sum(takenSpotChecks, seconds);
  const takenAdvances = takeWithin(advances, remaining, seconds);
  remaining -= sum(takenAdvances, seconds);
  const takenNews = guaranteed ? [guaranteed, ...takeWithin(news.slice(1), remaining, seconds)] : [];

  // 5. 穿插排列；推进项与新知识点在各自队列内按推荐顺序
  const sortByPosition = (list: PoolItem[]) =>
    [...list].sort((a, b) => (byPosition.get(a.knowledgePointId) ?? 0) - (byPosition.get(b.knowledgePointId) ?? 0));
  const items = interleave([[...takenReviews, ...takenSpotChecks], sortByPosition(takenAdvances), sortByPosition(takenNews)]);
  return { items, newPaused };
}

/**
 * 为某个知识点挑一项指定类型的内容：优先与上次不同的形式，没有时才退而用相同形式。
 * 对比讲解只在需要时由 findForm 挑选，日常不选。桌面上优先需要大段输入的形式（补全、修正），
 * 它们只能在桌面上完成；适合手机的同类内容留给手机。
 */
function pickItem(pool: PoolItem[], pointId: string, kind: PoolItem['kind'], lastForm: string | null, mobile: boolean) {
  const candidates = pool
    .filter((i) => i.knowledgePointId === pointId && i.kind === kind && i.form !== CONTRAST_FORM)
    .sort((a, b) => (mobile ? 0 : Number(isMobileForm(a.questionForm)) - Number(isMobileForm(b.questionForm))));
  return candidates.find((i) => i.form !== lastForm) ?? candidates[0];
}

function findForm(pool: PoolItem[], pointId: string, form: string) {
  return pool.find((i) => i.knowledgePointId === pointId && i.form === form);
}

/** 按顺序挑选放得进剩余时间的内容，放不下的跳过。 */
function takeWithin(list: PoolItem[], budget: number, seconds: (item: PoolItem) => number): PoolItem[] {
  const taken: PoolItem[] = [];
  let left = budget;
  for (const item of list) {
    if (seconds(item) <= left) {
      taken.push(item);
      left -= seconds(item);
    }
  }
  return taken;
}

function sum(list: PoolItem[], seconds: (item: PoolItem) => number) {
  return list.reduce((total, item) => total + seconds(item), 0);
}

/** 轮流从各队列取一项，直到全部取完。 */
function interleave(queues: PoolItem[][]): PoolItem[] {
  const result: PoolItem[] = [];
  const cursors = queues.map(() => 0);
  while (result.length < queues.reduce((n, q) => n + q.length, 0)) {
    queues.forEach((queue, i) => {
      const item = queue[cursors[i]!];
      if (item) {
        result.push(item);
        cursors[i]! += 1;
      }
    });
  }
  return result;
}
