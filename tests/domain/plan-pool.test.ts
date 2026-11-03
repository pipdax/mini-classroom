import { State, createEmptyCard } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import type { PoolItem } from '../../src/domain/assemble';
import type { GraphPoint } from '../../src/domain/edge';
import { type MemoryState, UNLEARNED } from '../../src/domain/memory';
import { planPool } from '../../src/domain/plan-pool';

const HOUR = 3600 * 1000;
const now = new Date('2026-10-20T12:00:00Z');
const base = { now, horizonMs: 48 * HOUR, newCount: 4 };

const point = (id: string, position: number, prerequisiteIds: string[] = []): GraphPoint => ({ id, position, prerequisiteIds });

function recallDueIn(hours: number, lastQuestionForm = 'mcq'): MemoryState {
  const card = { ...createEmptyCard(now), state: State.Review, reps: 1, stability: 2, due: new Date(now.getTime() + hours * HOUR) };
  return { ...UNLEARNED, stage: 'recall', card, lastExplainForm: 'explain_direct', lastQuestionForm };
}

const item = (knowledgePointId: string, kind: PoolItem['kind'], form: string, questionForm = form): PoolItem => ({
  id: `${knowledgePointId}-${kind}-${form}`,
  knowledgePointId,
  kind,
  form,
  questionForm,
  estSeconds: 60,
});

describe('低档题目准备', () => {
  it('所有阶段均备选择题，现有选择题可复用，不要求为了轮换而反复补题', () => {
    const states = new Map<string, MemoryState>([
      ['a', recallDueIn(1)],
      ['b', { ...recallDueIn(1), stage: 'apply' }],
      ['c', { ...recallDueIn(1), stage: 'retain' }],
    ]);
    const points = [point('a', 1), point('b', 2), point('c', 3)];
    const needs = planPool({ ...base, points, states, pool: [item('a', 'review', 'mcq')], reviewIntensity: 'low' });
    expect(needs).toEqual([
      { kind: 'review', knowledgePointId: 'b', questionForm: 'mcq' },
      { kind: 'review', knowledgePointId: 'c', questionForm: 'mcq' },
    ]);
  });

  it('已经轻松完成的不再备复习，误解仍需对比讲解和选择题', () => {
    const completed = { ...recallDueIn(1), reviewProgress: { attemptCount: 1, lastCorrectAt: now.toISOString(), completed: true } };
    const states = new Map([
      ['a', completed],
      ['b', { ...completed, pendingContrast: true }],
    ]);
    expect(planPool({ ...base, points: [point('a', 1), point('b', 2)], states, pool: [], reviewIntensity: 'low' })).toEqual([
      { kind: 'lesson', knowledgePointId: 'b', explainForm: 'explain_contrast', questionForm: 'mcq' },
    ]);
  });
});

describe('候选池补充规划', () => {
  it('新主题：为认知边缘上靠前的新知识点备讲解，小题形式交替', () => {
    const points = [point('a', 1), point('b', 2), point('c', 3), point('d', 4), point('e', 5), point('f', 6, ['a'])];
    const needs = planPool({ ...base, points, states: new Map(), pool: [] });
    expect(needs).toEqual([
      { kind: 'lesson', knowledgePointId: 'a', explainForm: 'explain_direct', questionForm: 'mcq' },
      { kind: 'lesson', knowledgePointId: 'b', explainForm: 'explain_direct', questionForm: 'short_answer' },
      { kind: 'lesson', knowledgePointId: 'c', explainForm: 'explain_direct', questionForm: 'mcq' },
      { kind: 'lesson', knowledgePointId: 'd', explainForm: 'explain_direct', questionForm: 'short_answer' },
    ]);
  });

  it('新补的小题形式与边缘上前一个已备好的知识点错开', () => {
    // 场景：a 上次已备好选择题，这次补 b、c
    const points = [point('a', 1), point('b', 2), point('c', 3)];
    const pool = [item('a', 'lesson', 'explain_direct', 'mcq')];
    const forms = planPool({ ...base, points, states: new Map(), pool }).map((n) => n.questionForm);
    expect(forms).toEqual(['short_answer', 'mcq']);
  });

  it('新知识点插在已备好的知识点前面时，与后一个错开', () => {
    // 场景：学会前置后，排序更靠前的 a 新进入边缘，b 上次已备好选择题
    const points = [point('a', 1), point('b', 2)];
    const pool = [item('b', 'lesson', 'explain_direct', 'mcq')];
    expect(planPool({ ...base, points, states: new Map(), pool })).toEqual([
      { kind: 'lesson', knowledgePointId: 'a', explainForm: 'explain_direct', questionForm: 'short_answer' },
    ]);
  });

  it('候选池里已有讲解的新知识点不重复生成', () => {
    const needs = planPool({ ...base, points: [point('a', 1)], states: new Map(), pool: [item('a', 'lesson', 'explain_direct')] });
    expect(needs).toEqual([]);
  });

  it('即将到期的复习备一项与上次形式不同的题；太远的不备', () => {
    const points = [point('soon', 1), point('far', 2)];
    const states = new Map([
      ['soon', recallDueIn(24, 'mcq')],
      ['far', recallDueIn(72, 'mcq')],
    ]);
    expect(planPool({ ...base, points, states, pool: [] })).toEqual([
      { kind: 'review', knowledgePointId: 'soon', questionForm: 'short_answer' },
    ]);
  });

  it('候选池里只有与上次相同形式的复习题时，仍要补一项不同形式的', () => {
    const states = new Map([['a', recallDueIn(1, 'mcq')]]);
    const needs = planPool({ ...base, points: [point('a', 1)], states, pool: [item('a', 'review', 'mcq')] });
    expect(needs).toEqual([{ kind: 'review', knowledgePointId: 'a', questionForm: 'short_answer' }]);
  });

  it('理解阶段的知识点备一项换了讲解形式和小题形式的重讲', () => {
    const states = new Map<string, MemoryState>([
      ['a', { ...UNLEARNED, stage: 'understand', lastExplainForm: 'explain_direct', lastQuestionForm: 'short_answer' }],
    ]);
    expect(planPool({ ...base, points: [point('a', 1)], states, pool: [item('a', 'lesson', 'explain_direct')] })).toEqual([
      { kind: 'lesson', knowledgePointId: 'a', explainForm: 'explain_analogy', questionForm: 'mcq' },
    ]);
  });
});

describe('候选池补充规划：四阶段、形式偏好与手机', () => {
  it('应用阶段即将到期：备一项修正题，另备一项适合手机的点选错误行', () => {
    const states = new Map([['a', { ...recallDueIn(1, 'pick_line'), stage: 'apply' as const }]]);
    expect(planPool({ ...base, points: [point('a', 1)], states, pool: [] })).toEqual([
      { kind: 'review', knowledgePointId: 'a', questionForm: 'fix' },
      { kind: 'review', knowledgePointId: 'a', questionForm: 'pick_line' },
    ]);
  });

  it('上次答错属于误解：备对比讲解，不备普通复习题', () => {
    const states = new Map([['a', { ...recallDueIn(1, 'mcq'), pendingContrast: true }]]);
    expect(planPool({ ...base, points: [point('a', 1)], states, pool: [] })).toEqual([
      { kind: 'lesson', knowledgePointId: 'a', explainForm: 'explain_contrast', questionForm: 'short_answer' },
    ]);
  });

  it('推断掌握的知识点备抽查题（适合手机的选择题）', () => {
    const states = new Map<string, MemoryState>([['a', { ...UNLEARNED, stage: 'inferred' }]]);
    expect(planPool({ ...base, points: [point('a', 1)], states, pool: [] })).toEqual([
      { kind: 'review', knowledgePointId: 'a', questionForm: 'mcq' },
    ]);
  });

  it('调高偏好的讲解形式用于新知识点；屏蔽的检验形式不出现', () => {
    const prefs = { blocked: ['short_answer'], boosted: ['explain_diagram'] };
    const needs = planPool({ ...base, points: [point('a', 1), point('b', 2)], states: new Map(), pool: [], prefs });
    expect(needs).toEqual([
      { kind: 'lesson', knowledgePointId: 'a', explainForm: 'explain_diagram', questionForm: 'mcq' },
      { kind: 'lesson', knowledgePointId: 'b', explainForm: 'explain_diagram', questionForm: 'mcq' },
    ]);
  });

  it('每个能新学的主题各备一份新知识点', () => {
    const points = [
      { ...point('t1-a', 1), topicId: 't1' },
      { ...point('t2-a', 2), topicId: 't2' },
    ];
    const needs = planPool({ ...base, points, states: new Map(), pool: [], newCount: 1 });
    expect(needs.map((n) => n.knowledgePointId)).toEqual(['t1-a', 't2-a']);
  });
});
