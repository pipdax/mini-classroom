import { State, createEmptyCard } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import { BACKLOG_SESSIONS, MAX_SPOT_CHECKS, type PoolItem, assemble } from '../../src/domain/assemble';
import type { GraphPoint } from '../../src/domain/edge';
import { type MemoryState, UNLEARNED } from '../../src/domain/memory';

const DAY = 24 * 3600 * 1000;
const now = new Date('2026-10-20T12:00:00Z');

/** 回忆阶段的知识点：逾期天数越多越容易忘 */
function recall(overdueDays: number, lastQuestionForm = 'mcq'): MemoryState {
  const lastReview = new Date(now.getTime() - (overdueDays + 2) * DAY);
  const card = {
    ...createEmptyCard(lastReview),
    state: State.Review,
    stability: 2,
    difficulty: 5,
    reps: 1,
    last_review: lastReview,
    due: new Date(now.getTime() - overdueDays * DAY),
  };
  return { ...UNLEARNED, stage: 'recall', card, lastExplainForm: 'explain_direct', lastQuestionForm };
}

function notDue(): MemoryState {
  const state = recall(0);
  return { ...state, card: { ...state.card!, due: new Date(now.getTime() + DAY) } };
}

const point = (id: string, position: number, prerequisiteIds: string[] = []): GraphPoint => ({ id, position, prerequisiteIds });
const review = (kp: string, form = 'short_answer', estSeconds = 60): PoolItem => ({
  id: `r-${kp}-${form}`,
  knowledgePointId: kp,
  kind: 'review',
  form,
  questionForm: form,
  estSeconds,
});
const lesson = (kp: string, form = 'explain_direct', estSeconds = 180): PoolItem => ({
  id: `l-${kp}-${form}`,
  knowledgePointId: kp,
  kind: 'lesson',
  form,
  questionForm: 'mcq',
  estSeconds,
});

const base = { now, budgetSeconds: 600, maxNewPerSession: 2 };
const ids = (items: PoolItem[]) => items.map((i) => i.id);
const total = (items: PoolItem[]) => items.reduce((s, i) => s + i.estSeconds, 0);
const reviewsFor = (count: number) => Array.from({ length: count }, (_, i) => point(`k${i}`, i));

describe('低档课堂安排', () => {
  it('已完成轻量巩固的不占复习预算，也不因旧到期记录而暂停新学', () => {
    const points = [...reviewsFor(40), point('new', 40)];
    const states = new Map(points.slice(0, 40).map((p) => [p.id, {
      ...recall(10), reviewProgress: { attemptCount: 1, lastCorrectAt: now.toISOString(), completed: true },
    }]));
    const pool = [...points.slice(0, 40).map((p) => review(p.id, 'mcq')), lesson('new')];
    const result = assemble({ ...base, points, states, pool, reviewIntensity: 'low' });
    expect(result.newPaused).toBe(false);
    expect(ids(result.items)).toEqual(['l-new-explain_direct']);
  });

  it('低档不使用旧简答题兜底，补好选择题后才安排', () => {
    const points = [point('a', 1)];
    const states = new Map([['a', recall(1)]]);
    expect(assemble({ ...base, points, states, pool: [review('a')], reviewIntensity: 'low' }).items).toEqual([]);
    expect(ids(assemble({ ...base, points, states, pool: [review('a'), review('a', 'mcq')], reviewIntensity: 'low' }).items)).toEqual(['r-a-mcq']);
  });
});

describe('组装规则', () => {
  it('到期复习按遗忘风险排序，最容易忘的在前；未到期的不排', () => {
    const points = [point('a', 1), point('b', 2), point('c', 3)];
    const states = new Map([
      ['a', recall(1)],
      ['b', recall(5)],
      ['c', notDue()],
    ]);
    const { items } = assemble({ ...base, points, states, pool: [review('a'), review('b'), review('c')] });
    expect(ids(items)).toEqual(['r-b-short_answer', 'r-a-short_answer']);
  });

  it('优先选与上次不同的形式', () => {
    const states = new Map([['a', recall(1, 'mcq')]]);
    const { items } = assemble({ ...base, points: [point('a', 1)], states, pool: [review('a', 'mcq'), review('a', 'short_answer')] });
    expect(ids(items)).toEqual(['r-a-short_answer']);
  });

  it('只有相同形式时仍安排复习，不让到期复习被跳过', () => {
    const states = new Map([['a', recall(1, 'mcq')]]);
    const { items } = assemble({ ...base, points: [point('a', 1)], states, pool: [review('a', 'mcq')] });
    expect(ids(items)).toEqual(['r-a-mcq']);
  });

  it('理解阶段的知识点用不同的讲解形式重讲', () => {
    const states = new Map<string, MemoryState>([['a', { ...UNLEARNED, stage: 'understand', lastExplainForm: 'explain_direct' }]]);
    const pool = [lesson('a', 'explain_direct'), lesson('a', 'explain_analogy')];
    const { items } = assemble({ ...base, points: [point('a', 1)], states, pool });
    expect(ids(items)).toEqual(['l-a-explain_analogy']);
  });

  it('已学过的知识点不再选用讲解内容', () => {
    const { items } = assemble({ ...base, points: [point('a', 1)], states: new Map([['a', notDue()]]), pool: [lesson('a')] });
    expect(items).toEqual([]);
  });

  it('总时长不超过预算', () => {
    const points = reviewsFor(12);
    const states = new Map(points.map((p, i) => [p.id, recall(i + 1)]));
    const pool = points.map((p) => review(p.id, 'short_answer', 90));
    const { items } = assemble({ ...base, points, states, pool, maxNewPerSession: 0 });
    expect(total(items)).toBeLessThanOrEqual(600);
    expect(items).toHaveLength(6);
  });

  it('新学保底：复习足以占满预算时，仍安排 1 个新知识点', () => {
    const reviewPoints = reviewsFor(10);
    const points = [...reviewPoints, point('new1', 100), point('new2', 101)];
    const states = new Map(reviewPoints.map((p, i) => [p.id, recall(i + 1)]));
    const pool = [...reviewPoints.map((p) => review(p.id)), lesson('new1'), lesson('new2')];
    const { items, newPaused } = assemble({ ...base, points, states, pool });
    expect(newPaused).toBe(false);
    expect(items.filter((i) => i.kind === 'lesson').map((i) => i.knowledgePointId)).toEqual(['new1']);
    expect(total(items)).toBeLessThanOrEqual(600);
  });

  it(`复习积压超过 ${BACKLOG_SESSIONS} 节的量时暂停新学`, () => {
    // 预算 600 秒 × 3 节 = 1800 秒；31 个 60 秒的到期复习 = 1860 秒
    const reviewPoints = reviewsFor(31);
    const points = [...reviewPoints, point('new1', 100)];
    const states = new Map(reviewPoints.map((p, i) => [p.id, recall(i + 1)]));
    const pool = [...reviewPoints.map((p) => review(p.id)), lesson('new1')];
    const { items, newPaused } = assemble({ ...base, points, states, pool });
    expect(newPaused).toBe(true);
    expect(items.some((i) => i.kind === 'lesson')).toBe(false);
  });

  it('积压刚好等于上限时不暂停新学', () => {
    const reviewPoints = reviewsFor(30);
    const points = [...reviewPoints, point('new1', 100)];
    const states = new Map(reviewPoints.map((p, i) => [p.id, recall(i + 1)]));
    const pool = [...reviewPoints.map((p) => review(p.id)), lesson('new1')];
    expect(assemble({ ...base, points, states, pool }).newPaused).toBe(false);
  });

  it('新知识点只来自认知边缘，且不超过每节上限', () => {
    const points = [point('n1', 1), point('n2', 2), point('n3', 3), point('blocked', 4, ['n1'])];
    const pool = ['n1', 'n2', 'n3', 'blocked'].map((kp) => lesson(kp, 'explain_direct', 100));
    const { items } = assemble({ ...base, points, states: new Map(), pool });
    expect(items.map((i) => i.knowledgePointId)).toEqual(['n1', 'n2']);
  });

  it('复习、推进、新学三类内容穿插排列，而不是分块', () => {
    const points = [point('r1', 1), point('r2', 2), point('u1', 3), point('n1', 4), point('n2', 5)];
    const states = new Map<string, MemoryState>([
      ['r1', recall(5)],
      ['r2', recall(1)],
      ['u1', { ...UNLEARNED, stage: 'understand', lastExplainForm: 'explain_direct' }],
    ]);
    const pool = [
      review('r1'),
      review('r2'),
      lesson('u1', 'explain_analogy', 120),
      lesson('n1', 'explain_direct', 120),
      lesson('n2', 'explain_direct', 120),
    ];
    const { items } = assemble({ ...base, points, states, pool });
    expect(items.map((i) => i.knowledgePointId)).toEqual(['r1', 'u1', 'n1', 'r2', 'n2']);
  });
});

describe('组装规则：四阶段与多主题', () => {
  const inferred: MemoryState = { ...UNLEARNED, stage: 'inferred' };

  it('上次答错属于误解的到期知识点，排对比讲解而不是普通复习题', () => {
    const states = new Map([['a', { ...recall(1), pendingContrast: true }]]);
    const pool = [review('a'), lesson('a', 'explain_contrast')];
    expect(ids(assemble({ ...base, points: [point('a', 1)], states, pool }).items)).toEqual(['l-a-explain_contrast']);
  });

  it('对比讲解不参与日常挑选：没有误解时照常出复习题', () => {
    const states = new Map([['a', recall(1)]]);
    const pool = [lesson('a', 'explain_contrast'), review('a')];
    expect(ids(assemble({ ...base, points: [point('a', 1)], states, pool }).items)).toEqual(['r-a-short_answer']);
  });

  it(`推断掌握的知识点每节最多抽查 ${MAX_SPOT_CHECKS} 个`, () => {
    const points = [point('i1', 1), point('i2', 2), point('i3', 3)];
    const states = new Map(points.map((p) => [p.id, inferred]));
    const pool = points.map((p) => review(p.id, 'mcq'));
    expect(assemble({ ...base, points, states, pool }).items.map((i) => i.knowledgePointId)).toEqual(['i1', 'i2']);
  });

  it('前置还没学会的理解阶段知识点（拆解后）先不重讲', () => {
    const points = [point('basic', 1), point('hard', 2, ['basic'])];
    const states = new Map<string, MemoryState>([['hard', { ...UNLEARNED, stage: 'understand', lastExplainForm: 'explain_direct' }]]);
    const pool = [lesson('basic'), lesson('hard', 'explain_analogy')];
    expect(assemble({ ...base, points, states, pool }).items.map((i) => i.knowledgePointId)).toEqual(['basic']);
  });

  it('新知识点只来自这一节选定的主题', () => {
    const points = [
      { ...point('t1-a', 1), topicId: 't1' },
      { ...point('t2-a', 2), topicId: 't2' },
      { ...point('t2-b', 3), topicId: 't2' },
    ];
    const pool = points.map((p) => lesson(p.id, 'explain_direct', 100));
    const { items } = assemble({ ...base, points, states: new Map(), pool, newTopicId: 't2' });
    expect(items.map((i) => i.knowledgePointId)).toEqual(['t2-a', 't2-b']);
  });

  it('手机上只挑适合手机的形式；桌面上优先补全、修正这类需要键盘的形式', () => {
    const states = new Map([['a', { ...recall(1), stage: 'apply' as const, lastQuestionForm: 'complete' }]]);
    const pool = [review('a', 'pick_line'), review('a', 'fix')];
    expect(ids(assemble({ ...base, points: [point('a', 1)], states, pool, mobile: true }).items)).toEqual(['r-a-pick_line']);
    expect(ids(assemble({ ...base, points: [point('a', 1)], states, pool }).items)).toEqual(['r-a-fix']);
  });

  it('按校准系数换算时长：实际用时是预估的 2 倍时，放得下的内容减半', () => {
    const points = reviewsFor(10);
    const states = new Map(points.map((p, i) => [p.id, recall(i + 1)]));
    const pool = points.map((p) => review(p.id, 'short_answer', 60));
    expect(assemble({ ...base, points, states, pool, maxNewPerSession: 0 }).items).toHaveLength(10);
    expect(assemble({ ...base, points, states, pool, maxNewPerSession: 0, timeFactor: 2 }).items).toHaveLength(5);
  });
});
