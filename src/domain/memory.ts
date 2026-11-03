import { type Card, type Grade, Rating, createEmptyCard, fsrs } from 'ts-fsrs';
import type { CheckStage } from './forms';
import { EMPTY_REVIEW_PROGRESS, UNCONFIRMED_REVIEW_PROGRESS, type ReviewContext, type ReviewIntensity, type ReviewProgress, nextReviewProgress } from './review';

/**
 * 掌握阶段：理解 → 回忆 → 应用 → 保持。
 * inferred（推断掌握）：摸底时没有直接考、但由前置关系推断已会，先不教，抽查一题再定。
 */
export type Stage = 'unlearned' | 'inferred' | 'understand' | 'recall' | 'apply' | 'retain';
export type SelfRating = 'hard' | 'good' | 'easy';
export type ErrorType = 'misconception' | 'forgetting';

/** 一次作答的结果：答错时不自评，带上错误类型；答对时由用户自评难度。 */
export type Outcome =
  | { correct: false; errorType?: ErrorType; misconception?: string | null }
  | { correct: true; selfRating: SelfRating };

/** 记忆状态：按"用户 × 知识点"只记一份。 */
export interface MemoryState {
  stage: Stage;
  card: Card | null;
  lastExplainForm: string | null;
  lastQuestionForm: string | null;
  /** 理解、回忆阶段连续答错的次数，达到阈值时触发拆解 */
  failStreak: number;
  /** 上次答错属于误解：下一次讲解或复习改用对比讲解 */
  pendingContrast: boolean;
  /** 最近一次误解的内容，供对比讲解有针对性地讲 */
  lastMisconception: string | null;
  /** 旧的作答快照可能尚未记录轻量巩固证据。 */
  reviewProgress?: ReviewProgress;
}

export const UNLEARNED: MemoryState = {
  stage: 'unlearned',
  card: null,
  lastExplainForm: null,
  lastQuestionForm: null,
  failStreak: 0,
  pendingContrast: false,
  lastMisconception: null,
  reviewProgress: EMPTY_REVIEW_PROGRESS,
};

/** 回忆阶段答对后，记忆稳定性达到这么多天，进入应用阶段 */
export const APPLY_STABILITY_DAYS = 7;
/** 应用阶段答对后，记忆稳定性达到这么多天，进入保持阶段 */
export const RETAIN_STABILITY_DAYS = 30;
/** 摸底时直接答对的知识点，这么多天后再验证一次（需求：两三周后） */
export const PLACEMENT_VERIFY_DAYS = 17;
/** 理解或回忆阶段连续答错这么多次，触发拆解 */
export const DECOMPOSE_FAIL_STREAK = 3;

// 微课堂之间通常相隔数小时，不使用分钟级的短期学习步；关闭随机扰动，保证调度可复现。
export const scheduler = fsrs({ enable_short_term: false, enable_fuzz: false });

/** 记忆评分：判错直接记"忘了"，答对按自评映射。 */
export function toGrade(outcome: Outcome): Grade {
  if (!outcome.correct) return Rating.Again;
  const map: Record<SelfRating, Grade> = { hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy };
  return map[outcome.selfRating];
}

/** 已学过：进入回忆及之后的阶段，或推断已会。前置都学过的知识点才进入认知边缘。 */
export function hasLearned(stage: Stage): boolean {
  return stage === 'inferred' || hasSchedule(stage);
}

/** 有间隔调度（FSRS 卡片）的阶段 */
export function hasSchedule(stage: Stage): boolean {
  return stage === 'recall' || stage === 'apply' || stage === 'retain';
}

/** 出题时按哪个阶段的形式池挑选：推断掌握的抽查按回忆阶段出题 */
export function checkStageOf(stage: Stage): CheckStage {
  if (stage === 'unlearned' || stage === 'understand') return 'understand';
  if (stage === 'inferred') return 'recall';
  return stage;
}

/**
 * 讲解后的当场小题作答完毕。
 * 答对：进入回忆阶段，开始间隔调度。答错：留在理解阶段，下次换一种讲解形式重讲；
 * 错误类型是误解时，下次改用对比讲解。
 */
export function applyLessonOutcome(
  state: MemoryState,
  forms: { explainForm: string; questionForm: string },
  outcome: Outcome,
  now: Date,
  context?: ReviewContext,
): MemoryState {
  if (hasLearned(state.stage)) throw new Error(`知识点已处于 ${state.stage} 阶段，不能再按讲解结果更新`);
  const base = {
    lastExplainForm: forms.explainForm,
    lastQuestionForm: forms.questionForm,
    reviewProgress: nextReviewProgress(progressOf(state), forms.questionForm, outcome, context?.answeredAt ?? now, context?.timeZone ?? 'UTC'),
  };
  if (!outcome.correct) return { ...state, ...base, ...afterWrong(state, outcome), stage: 'understand', card: null };
  const card = scheduler.next(createEmptyCard(now), now, toGrade(outcome)).card;
  return { ...state, ...base, ...afterRight(), stage: 'recall', card };
}

/**
 * 复习题（含对比讲解后的小题、推断掌握的抽查）作答完毕。
 * - 推断掌握：答对视为已掌握，进入回忆阶段；答错从理解阶段开始教。
 * - 回忆、应用、保持：按记忆评分更新卡片。答对且记忆足够稳定时进入下一阶段；
 *   答错退回回忆阶段，间隔由 FSRS 缩短。
 */
export function applyReviewOutcome(state: MemoryState, questionForm: string, outcome: Outcome, now: Date, context?: ReviewContext): MemoryState {
  const reviewProgress = nextReviewProgress(progressOf(state), questionForm, outcome, context?.answeredAt ?? now, context?.timeZone ?? 'UTC');
  if (state.stage === 'inferred') {
    if (!outcome.correct) return { ...state, ...afterWrong(state, outcome), reviewProgress, lastQuestionForm: questionForm, stage: 'understand', card: null };
    const card = scheduler.next(createEmptyCard(now), now, toGrade(outcome)).card;
    return { ...state, ...afterRight(), reviewProgress, lastQuestionForm: questionForm, stage: 'recall', card };
  }
  if (!hasSchedule(state.stage) || state.card === null) throw new Error('知识点尚未进入回忆阶段，不能按复习结果更新');
  const card = scheduler.next(state.card, now, toGrade(outcome)).card;
  if (!outcome.correct) return { ...state, ...afterWrong(state, outcome), reviewProgress, card, lastQuestionForm: questionForm, stage: 'recall' };
  const stage = context?.intensity === 'low' ? state.stage : promote(state.stage, card);
  return { ...state, ...afterRight(), reviewProgress, card, lastQuestionForm: questionForm, stage };
}

/** 没有历史证据的已学内容，先保留复习；推断掌握仍需一次实际检验。 */
function progressOf(state: MemoryState): ReviewProgress {
  if (state.reviewProgress) return state.reviewProgress;
  if (state.stage === 'unlearned' || state.stage === 'inferred') return EMPTY_REVIEW_PROGRESS;
  return UNCONFIRMED_REVIEW_PROGRESS;
}

/** 答对后是否进入下一阶段：看答对后的记忆稳定性（天） */
function promote(stage: Stage, card: Card): Stage {
  if (stage === 'recall' && card.stability >= APPLY_STABILITY_DAYS) return 'apply';
  if (stage === 'apply' && card.stability >= RETAIN_STABILITY_DAYS) return 'retain';
  return stage;
}

function afterRight(): Pick<MemoryState, 'failStreak' | 'pendingContrast' | 'lastMisconception'> {
  return { failStreak: 0, pendingContrast: false, lastMisconception: null };
}

/** 答错后的计数与对比教学标记：只有理解、回忆阶段的失败计入连续答错 */
function afterWrong(state: MemoryState, outcome: Extract<Outcome, { correct: false }>) {
  const counts = state.stage === 'unlearned' || state.stage === 'understand' || state.stage === 'recall';
  const misconception = outcome.errorType === 'misconception';
  return {
    failStreak: counts ? state.failStreak + 1 : 0,
    pendingContrast: misconception,
    lastMisconception: misconception ? (outcome.misconception ?? state.lastMisconception) : null,
  };
}

/** 连续答错达到阈值、且仍在理解或回忆阶段：需要拆解出更基础的前置知识点 */
export function needsDecomposition(state: MemoryState): boolean {
  return state.failStreak >= DECOMPOSE_FAIL_STREAK && (state.stage === 'understand' || state.stage === 'recall');
}

/**
 * 摸底诊断的结果换算成初始记忆状态：
 * - 直接答对：不再教，进入回忆阶段，两三周后到期再验证一次；
 * - 推断掌握：先不教，后续抽查；
 * - 答错或选"不知道"：按未学处理。
 */
export function fromPlacement(result: 'correct' | 'inferred' | 'unknown', now: Date): MemoryState {
  if (result === 'unknown') return UNLEARNED;
  if (result === 'inferred') return { ...UNLEARNED, stage: 'inferred' };
  // 按"轻松"建卡，再把到期时间定在两三周后（FSRS 默认参数下"轻松"只给 8 天左右）
  const card = scheduler.next(createEmptyCard(now), now, Rating.Easy).card;
  const due = new Date(now.getTime() + PLACEMENT_VERIFY_DAYS * 24 * 3600 * 1000);
  return { ...UNLEARNED, stage: 'recall', reviewProgress: UNCONFIRMED_REVIEW_PROGRESS, card: { ...card, due, scheduled_days: PLACEMENT_VERIFY_DAYS } };
}

/**
 * 重新学习：已学过的知识点退回理解阶段，清掉间隔调度。
 * 理解阶段的知识点由下一节微课堂换一种讲解形式重讲，答对后重新开始调度。
 */
export function relearn(state: MemoryState): MemoryState {
  if (!hasLearned(state.stage)) throw new Error(`知识点处于 ${state.stage} 阶段，还没学过，不能重新学习`);
  return { ...state, stage: 'understand', card: null, failStreak: 0, reviewProgress: EMPTY_REVIEW_PROGRESS };
}

/** 完成轻量巩固只停止低档下的自动复习，不改变学习阶段。 */
export function reviewCompleted(state: MemoryState, intensity: ReviewIntensity): boolean {
  return intensity === 'low' && hasSchedule(state.stage) && !state.pendingContrast && state.reviewProgress?.completed === true;
}

/** 所有复习入口共用的到期时间，已完成轻量巩固时不再排期。 */
export function reviewDueAt(state: MemoryState, intensity: ReviewIntensity): Date | null {
  if (!hasSchedule(state.stage) || reviewCompleted(state, intensity)) return null;
  return state.card?.due ?? null;
}

/** 此刻是否到期复习。 */
export function isDue(state: MemoryState, now: Date, intensity: ReviewIntensity = 'high'): boolean {
  const due = reviewDueAt(state, intensity);
  return due !== null && due.getTime() <= now.getTime();
}

/** 此刻还能想起来的概率，越低越容易忘。 */
export function retrievability(card: Card, now: Date): number {
  return scheduler.get_retrievability(card, now, false);
}

/** 从数据库 JSON 还原卡片中的日期字段。 */
export function reviveCard(raw: unknown): Card | null {
  if (raw === null || raw === undefined) return null;
  const card = raw as Card & { due: string | Date; last_review?: string | Date };
  return {
    ...card,
    due: new Date(card.due),
    last_review: card.last_review === undefined ? undefined : new Date(card.last_review),
  };
}
