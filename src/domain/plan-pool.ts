import type { PoolItem } from './assemble';
import { type GraphPoint, cognitiveEdge, prerequisitesSatisfied } from './edge';
import {
  CONTRAST_FORM,
  type ExplainForm,
  type FormPrefs,
  NO_PREFS,
  type QuestionForm,
  explainFormsFor,
  isMobileForm,
  pickForm,
  questionFormsFor,
} from './forms';
import { type MemoryState, UNLEARNED, checkStageOf, reviewDueAt } from './memory';
import type { ReviewIntensity } from './review';

/** 候选池需要补的一项内容 */
export type PoolNeed =
  | { kind: 'review'; knowledgePointId: string; questionForm: QuestionForm }
  | { kind: 'lesson'; knowledgePointId: string; explainForm: ExplainForm; questionForm: QuestionForm };

export interface PlanPoolInput {
  reviewIntensity?: ReviewIntensity;
  points: GraphPoint[];
  states: Map<string, MemoryState>;
  pool: PoolItem[];
  now: Date;
  /** 提前多久为即将到期的复习备好内容 */
  horizonMs: number;
  /** 每个主题在认知边缘上提前备好多少个新知识点 */
  newCount: number;
  /** 提前备好多少个推断掌握知识点的抽查题 */
  spotCheckCount?: number;
  prefs?: FormPrefs;
}

/**
 * 规划候选池要补哪些内容，目标是常备约两节的量：
 * - 即将到期（horizon 内）的复习：每个知识点备一项按其阶段形式池轮换、与上次不同的题；
 *   这一项不适合手机时，另备一项适合手机的；上次答错属于误解的，改备对比讲解；
 * - 理解阶段的知识点：备一项与上次讲解形式不同的重讲（误解后为对比讲解）；
 * - 推断掌握的知识点：按推荐顺序为前几个备抽查题；
 * - 每个能新学的主题，认知边缘上靠前的新知识点：各备一项讲解，当场小题的形式与边缘上相邻的知识点错开，
 *   这样组装时按边缘顺序取出的新知识点，小题形式自然交替。
 * 候选池里已有可用内容的，不重复生成。
 */
export function planPool(input: PlanPoolInput): PoolNeed[] {
  const { points, states, pool, now, horizonMs, newCount, spotCheckCount = 4, prefs = NO_PREFS, reviewIntensity = 'high' } = input;
  const stateOf = (id: string) => states.get(id) ?? UNLEARNED;
  const itemsOf = (id: string, kind: PoolItem['kind']) => pool.filter((i) => i.knowledgePointId === id && i.kind === kind && (reviewIntensity !== 'low' || i.questionForm === 'mcq'));
  const hasOther = (id: string, kind: PoolItem['kind'], avoidForm: string | null) =>
    itemsOf(id, kind).some((i) => ((kind === 'review' && reviewIntensity === 'low') || i.form !== avoidForm) && i.form !== CONTRAST_FORM);
  const hasContrast = (id: string) => itemsOf(id, 'lesson').some((i) => i.form === CONTRAST_FORM);
  const byPosition = points.filter((p) => !p.excluded).sort((a, b) => a.position - b.position);
  const excludedIds = new Set(points.filter((p) => p.excluded).map((p) => p.id));
  const needs: PoolNeed[] = [];

  for (const p of byPosition) {
    const state = stateOf(p.id);
    const checkStage = checkStageOf(state.stage);
    const due = reviewDueAt(state, reviewIntensity);
    const dueSoon = due !== null && due.getTime() <= now.getTime() + horizonMs;

    if (dueSoon && state.pendingContrast) {
      if (!hasContrast(p.id)) {
        needs.push({
          kind: 'lesson',
          knowledgePointId: p.id,
          explainForm: CONTRAST_FORM,
          questionForm: pickForm(questionFormsFor(checkStage, prefs, false, reviewIntensity), state.lastQuestionForm),
        });
      }
    } else if (dueSoon) {
      const questionForm = pickForm(questionFormsFor(checkStage, prefs, false, reviewIntensity), state.lastQuestionForm);
      if (!hasOther(p.id, 'review', state.lastQuestionForm)) needs.push({ kind: 'review', knowledgePointId: p.id, questionForm });
      // 每个到期知识点至少备有一种适合手机的形式
      const hasMobile = itemsOf(p.id, 'review').some((i) => isMobileForm(i.questionForm));
      if (!isMobileForm(questionForm) && !hasMobile) {
        needs.push({
          kind: 'review',
          knowledgePointId: p.id,
          questionForm: pickForm(questionFormsFor(checkStage, prefs, true, reviewIntensity), state.lastQuestionForm),
        });
      }
    }

    if (state.stage === 'understand' && prerequisitesSatisfied(p, (id) => stateOf(id).stage, excludedIds)) {
      const missing = state.pendingContrast ? !hasContrast(p.id) : !hasOther(p.id, 'lesson', state.lastExplainForm);
      if (missing) {
        needs.push({
          kind: 'lesson',
          knowledgePointId: p.id,
          explainForm: state.pendingContrast ? CONTRAST_FORM : pickForm(explainFormsFor(prefs), state.lastExplainForm, prefs.boosted),
          questionForm: pickForm(questionFormsFor('understand', prefs, false, reviewIntensity), state.lastQuestionForm),
        });
      }
    }
  }

  const inferred = byPosition.filter((p) => stateOf(p.id).stage === 'inferred').slice(0, spotCheckCount);
  for (const p of inferred) {
    if (itemsOf(p.id, 'review').length === 0) {
      needs.push({ kind: 'review', knowledgePointId: p.id, questionForm: pickForm(questionFormsFor('recall', prefs, true, reviewIntensity), null) });
    }
  }

  // 每个能新学的主题各备一份：新学按主题轮换，轮到哪个主题都有现成的讲解
  const edge = cognitiveEdge(points, states);
  const topics = [...new Set(edge.map((p) => p.topicId))];
  const explainForm = pickForm(explainFormsFor(prefs), null, prefs.boosted);
  const checkForms = questionFormsFor('understand', prefs, false, reviewIntensity);
  for (const topicId of topics) {
    const topicEdge = edge.filter((p) => p.topicId === topicId).slice(0, newCount);
    // 边缘上每个知识点已备讲解的小题形式；没备的为 null，下面依次补上
    const forms = topicEdge.map((p) => itemsOf(p.id, 'lesson')[0]?.questionForm ?? null);
    topicEdge.forEach((p, i) => {
      if (forms[i] !== null) return;
      const questionForm = alternateForm(checkForms, forms[i - 1] ?? null, forms[i + 1] ?? null);
      forms[i] = questionForm;
      needs.push({ kind: 'lesson', knowledgePointId: p.id, explainForm, questionForm });
    });
  }

  return needs;
}

/** 与前一个相邻知识点的形式错开；没有前一个时，与后一个错开。 */
function alternateForm(forms: QuestionForm[], previous: string | null, next: string | null): QuestionForm {
  const neighbor = previous ?? next;
  return neighbor === null ? forms[0]! : pickForm(forms, neighbor);
}
