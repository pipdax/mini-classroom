import { describe, expect, it } from 'vitest';
import { UNLEARNED, applyLessonOutcome, applyReviewOutcome, isDue, relearn, reviewCompleted } from '../../src/domain/memory';
import { EMPTY_REVIEW_PROGRESS, nextReviewProgress } from '../../src/domain/review';

const day1 = new Date('2026-11-03T09:00:00Z');
const day2 = new Date('2026-11-04T09:00:00Z');
const easy = { correct: true, selfRating: 'easy' } as const;
const good = { correct: true, selfRating: 'good' } as const;
const forms = { explainForm: 'explain_direct', questionForm: 'mcq' };

describe('轻量巩固的结束条件', () => {
  it('首次选择题答对且轻松即可完成，保留记忆和前置学习进度', () => {
    const state = applyLessonOutcome(UNLEARNED, forms, easy, day1);
    expect(reviewCompleted(state, 'low')).toBe(true);
    expect(reviewCompleted(state, 'high')).toBe(false);
    expect(state.stage).toBe('recall');
    expect(state.card).not.toBeNull();
    const later = new Date('2027-11-03T09:00:00Z');
    expect(isDue(state, later, 'low')).toBe(false);
    expect(isDue(state, later, 'high')).toBe(true);
  });

  it.each(['good', 'hard'] as const)('首次自评 %s 不能结束复习', (selfRating) => {
    const state = applyLessonOutcome(UNLEARNED, forms, { correct: true, selfRating }, day1);
    expect(reviewCompleted(state, 'low')).toBe(false);
  });

  it('首次简答轻松通过，不套用首次选择题结束规则', () => {
    const state = applyLessonOutcome(UNLEARNED, { ...forms, questionForm: 'short_answer' }, easy, day1);
    expect(reviewCompleted(state, 'low')).toBe(false);
  });

  it('答错后立即改对不能结束；跨日连续答对且最后轻松才结束', () => {
    let progress = nextReviewProgress(EMPTY_REVIEW_PROGRESS, 'mcq', { correct: false }, day1);
    progress = nextReviewProgress(progress, 'mcq', easy, day1);
    expect(progress.completed).toBe(false);
    progress = nextReviewProgress(progress, 'mcq', good, day2);
    expect(progress.completed).toBe(false);
    progress = nextReviewProgress(progress, 'mcq', easy, new Date('2026-11-05T09:00:00Z'));
    expect(progress.completed).toBe(true);
  });

  it('两次正确之间出现错误，必须重新累积连续正确记录', () => {
    let progress = nextReviewProgress(EMPTY_REVIEW_PROGRESS, 'mcq', good, day1);
    progress = nextReviewProgress(progress, 'mcq', { correct: false }, day1);
    progress = nextReviewProgress(progress, 'mcq', easy, day2);
    expect(progress.completed).toBe(false);
  });

  it('按用户时区判断跨日，同一日期的重复正确不算跨日确认', () => {
    const beforeMidnight = new Date('2026-11-03T15:50:00Z');
    const afterMidnight = new Date('2026-11-03T16:10:00Z');
    const progress = nextReviewProgress(EMPTY_REVIEW_PROGRESS, 'mcq', good, beforeMidnight, 'Asia/Manila');
    expect(nextReviewProgress(progress, 'mcq', easy, afterMidnight, 'Asia/Manila').completed).toBe(true);
    expect(nextReviewProgress(progress, 'mcq', easy, afterMidnight, 'UTC').completed).toBe(false);
  });

  it('低档选择题巩固不会直接升级为应用或保持，高档仍按原有规则升级', () => {
    const state = applyLessonOutcome(UNLEARNED, forms, good, day1);
    const due = state.card!.due;
    const low = applyReviewOutcome(state, 'mcq', easy, due, { intensity: 'low', timeZone: 'UTC', answeredAt: due });
    const high = applyReviewOutcome(state, 'short_answer', easy, due, { intensity: 'high', timeZone: 'UTC', answeredAt: due });
    expect(low.stage).toBe('recall');
    expect(high.stage).toBe('apply');
  });

  it('跨日看实际作答时间，隔天补自评不能把同日作答当作跨日确认', () => {
    const state = applyLessonOutcome(UNLEARNED, forms, good, day1);
    const next = applyReviewOutcome(state, 'mcq', easy, day2, { intensity: 'low', timeZone: 'UTC', answeredAt: day1 });
    expect(reviewCompleted(next, 'low')).toBe(false);
  });

  it('重新学习清除完成状态和连续正确证据', () => {
    const learned = applyLessonOutcome(UNLEARNED, forms, easy, day1);
    const state = relearn(learned);
    expect(reviewCompleted(state, 'low')).toBe(false);
    expect(state.reviewProgress).toEqual(EMPTY_REVIEW_PROGRESS);
  });
});
