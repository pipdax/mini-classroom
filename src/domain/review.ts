import type { Outcome } from './memory';

export type ReviewIntensity = 'low' | 'high';

/** 本次考查实际使用的课堂规则和作答时间。 */
export interface ReviewContext {
  intensity: ReviewIntensity;
  timeZone: string;
  answeredAt: Date;
}

/** 轻量巩固的作答证据，与掌握阶段和记忆参数分开保存。 */
export interface ReviewProgress {
  attemptCount: number;
  lastCorrectAt: string | null;
  completed: boolean;
}

export const EMPTY_REVIEW_PROGRESS: ReviewProgress = { attemptCount: 0, lastCorrectAt: null, completed: false };
/** 已有学习或错误证据，但不足以判断轻松；下次不能按首次轻松直接结束。 */
export const UNCONFIRMED_REVIEW_PROGRESS: ReviewProgress = { attemptCount: 1, lastCorrectAt: null, completed: false };

/** 根据有效作答更新证据：首次选择题轻松通过，或跨日连续正确且最后轻松。 */
export function nextReviewProgress(
  previous: ReviewProgress,
  questionForm: string,
  outcome: Outcome,
  now: Date,
  timeZone = 'UTC',
): ReviewProgress {
  const attemptCount = previous.attemptCount + 1;
  if (!outcome.correct) return { attemptCount, lastCorrectAt: null, completed: false };

  const dayOf = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const firstEasyCheck = previous.attemptCount === 0 && questionForm === 'mcq';
  const previousCorrect = previous.lastCorrectAt === null ? null : new Date(previous.lastCorrectAt);
  const confirmedAcrossDays = previousCorrect !== null && previousCorrect < now && dayOf.format(previousCorrect) !== dayOf.format(now);
  return {
    attemptCount,
    lastCorrectAt: now.toISOString(),
    completed: outcome.selfRating === 'easy' && (firstEasyCheck || confirmedAcrossDays),
  };
}
