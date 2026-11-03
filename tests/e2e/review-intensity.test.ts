import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { StructuredModel, StructuredRequest } from '../../src/ai/gateway';
import { fillPool } from '../../src/jobs/fill-pool';
import { settingsSource } from '../../src/settings';
import { loadPoints, loadPool, loadStates } from '../../src/store/repo';
import { appSettings, attempts, memoryStates } from '../../src/store/schema';
import { APPEAL_ACCEPT_MARK, APPEAL_VOID_MARK, CORRECT_MARK, MCQ } from '../fixtures/fake-model';
import { DAY1, createHarness } from '../fixtures/harness';

type Harness = ReturnType<typeof createHarness>;
const future = new Date('2027-04-20T09:00:00Z');

async function start(intensity: 'low' | 'high' = 'low') {
  const h = createHarness();
  await h.call('PUT', '/api/settings', { reviewIntensity: intensity });
  await h.startTopic();
  const session = (await h.call('POST', '/api/sessions/next', { timeZone: 'Asia/Manila' })).body.session;
  return { h, session, item: session.items[0] };
}

/** 经公共接口答题和自评，保留真实的学习、调度与留档过程。 */
async function answer(h: Harness, session: any, item: any, rating: 'easy' | 'good' | 'hard' | 'wrong', now = DAY1) {
  const submitted = await h.call('POST', '/api/attempts', {
    sessionId: session.id,
    itemId: item.id,
    answer: item.question.type === 'mcq'
      ? { choice: rating === 'wrong' ? -1 : MCQ.answerIndex }
      : { text: rating === 'wrong' ? '不知道' : CORRECT_MARK },
  }, now);
  expect(submitted.status).toBe(201);
  expect(submitted.body.correct).toBe(rating !== 'wrong');
  if (rating !== 'wrong') {
    expect((await h.call('POST', `/api/attempts/${submitted.body.attemptId}/rating`, { selfRating: rating }, now)).status).toBe(200);
  }
  return submitted.body.attemptId as string;
}

async function finish(h: Harness, session: any, now = DAY1) {
  expect((await h.call('POST', `/api/sessions/${session.id}/finish`, undefined, now)).status).toBe(200);
  await h.worker.runUntilIdle();
}

async function review(h: Harness, pointId: string) {
  const now = loadStates(h.db).get(pointId)!.card!.due;
  await fillPool({ db: h.db, model: h.model, settings: settingsSource(h.db, {}), clock: () => now, illustrations: false }, now);
  const session = (await h.call('POST', '/api/sessions/next', { timeZone: 'Asia/Manila' }, now)).body.session;
  const item = session.items.find((entry: any) => entry.knowledgePointId === pointId && entry.kind !== 'connection');
  expect(item).toBeDefined();
  return { session, item, now };
}

describe('复习强度完整学习流程', () => {
  it('默认及缺少字段的旧设置均为高档，非法强度拒绝保存', async () => {
    const h = createHarness();
    expect((await h.call('GET', '/api/settings')).body.settings.reviewIntensity).toBe('high');
    h.db.insert(appSettings).values({ key: 'user_settings', value: { sessionMinutes: 15 }, updatedAt: DAY1 }).run();
    expect((await h.call('GET', '/api/settings')).body.settings).toMatchObject({ sessionMinutes: 15, reviewIntensity: 'high' });
    expect((await h.call('PUT', '/api/settings', { reviewIntensity: 'medium' })).status).toBe(400);
    expect((await h.call('PUT', '/api/settings', { reviewIntensity: 'low' })).body.reviewIntensity).toBe('low');
  });

  it('首次轻松通过后停止备复习题，地图与预览不计积压，保留学习记录', async () => {
    const { h, session, item } = await start();
    expect(session.reviewIntensity).toBe('low');
    expect(session.items.filter((entry: any) => entry.question).every((entry: any) => entry.question.type === 'mcq')).toBe(true);
    await answer(h, session, item, 'easy');
    await finish(h, session);
    const detail = (await h.call('GET', `/api/points/${item.knowledgePointId}`)).body;
    expect(detail).toMatchObject({ stage: 'recall', excluded: false, reviewCompleted: true, nextReviewAt: null, canRelearn: true });
    expect(detail.records).toHaveLength(1);
    expect((await h.call('GET', '/api/sessions/preview', undefined, future)).body.dueCount).toBe(0);
    const map = (await h.call('GET', '/api/map', undefined, future)).body;
    expect(map.topics[0]).toMatchObject({ learned: 1, due: 0 });
    expect(map.points.find((point: any) => point.id === item.knowledgePointId)).toMatchObject({ reviewCompleted: true, nextReviewAt: null });
    await fillPool({ db: h.db, model: h.model, settings: settingsSource(h.db, {}), clock: () => future, illustrations: false }, future);
    expect(loadPool(h.db).some((entry) => entry.knowledgePointId === item.knowledgePointId && entry.kind === 'review')).toBe(false);
  });

  it('良好内容继续用选择题复习，跨日轻松通过后结束且不冒充应用能力', async () => {
    const { h, session, item } = await start();
    await answer(h, session, item, 'good');
    await finish(h, session);
    expect((await h.call('GET', `/api/points/${item.knowledgePointId}`)).body.reviewCompleted).toBe(false);
    const next = await review(h, item.knowledgePointId);
    expect(next.item.question.type).toBe('mcq');
    await answer(h, next.session, next.item, 'easy', next.now);
    expect((await h.call('GET', `/api/points/${item.knowledgePointId}`)).body).toMatchObject({ stage: 'recall', reviewCompleted: true, nextReviewAt: null });
  });

  it('答错后同日重讲答对不能结束，下一次跨日确认后才结束', async () => {
    const { h, session, item } = await start();
    await answer(h, session, item, 'wrong');
    await finish(h, session);
    const again = (await h.call('POST', '/api/sessions/next')).body.session;
    const retry = again.items.find((entry: any) => entry.knowledgePointId === item.knowledgePointId);
    expect(retry.question.type).toBe('mcq');
    await answer(h, again, retry, 'easy');
    await finish(h, again);
    expect((await h.call('GET', `/api/points/${item.knowledgePointId}`)).body.reviewCompleted).toBe(false);
    const next = await review(h, item.knowledgePointId);
    await answer(h, next.session, next.item, 'easy', next.now);
    expect((await h.call('GET', `/api/points/${item.knowledgePointId}`)).body.reviewCompleted).toBe(true);
  });

  it('切换强度不改变正在进行的题目及评分规则，下一节才采用新档位', async () => {
    const { h, session, item } = await start('high');
    await answer(h, session, item, 'good');
    await finish(h, session);
    const next = await review(h, item.knowledgePointId);
    expect(next.session.reviewIntensity).toBe('high');
    expect(next.item.question.type).toBe('short_answer');
    await h.call('PUT', '/api/settings', { reviewIntensity: 'low' }, next.now);
    const resumed = (await h.call('POST', '/api/sessions/next', undefined, next.now)).body;
    expect(resumed).toMatchObject({ resumed: true, session: next.session });
    await answer(h, next.session, next.item, 'easy', next.now);
    expect(loadStates(h.db).get(item.knowledgePointId)!.stage).toBe('apply');
    await finish(h, next.session, next.now);
    const low = (await h.call('POST', '/api/sessions/next', { fresh: true }, next.now)).body.session;
    expect(low.reviewIntensity).toBe('low');
    expect(low.items.filter((entry: any) => entry.question).every((entry: any) => entry.question.type === 'mcq')).toBe(true);
  });

  it('低档切回高档恢复原有排期和混合题型，不清除学习记录', async () => {
    const { h, session, item } = await start();
    await answer(h, session, item, 'easy');
    await finish(h, session);
    const before = loadStates(h.db).get(item.knowledgePointId);
    await h.call('PUT', '/api/settings', { reviewIntensity: 'high' });
    expect(loadStates(h.db).get(item.knowledgePointId)).toEqual(before);
    expect((await h.call('GET', '/api/sessions/preview', undefined, future)).body.dueCount).toBe(1);
    const next = await review(h, item.knowledgePointId);
    expect(next.item.question.type).toBe('short_answer');
    expect((await h.call('GET', `/api/points/${item.knowledgePointId}`)).body).toMatchObject({ reviewCompleted: false, nextReviewAt: before!.card!.due.toISOString() });
  });

  it('高档旧记录没有新字段时仍能按有效历史判断轻松，重新学习后清除证据', async () => {
    const { h, session, item } = await start('high');
    const attemptId = await answer(h, session, item, 'easy');
    await finish(h, session);
    h.db.update(memoryStates).set({ reviewProgress: null }).where(eq(memoryStates.knowledgePointId, item.knowledgePointId)).run();
    const record = h.db.select().from(attempts).where(eq(attempts.id, attemptId)).get()!;
    const before = { ...(record.stateBefore as Record<string, unknown>) };
    delete before.reviewProgress;
    h.db.update(attempts).set({ stateBefore: before }).where(eq(attempts.id, attemptId)).run();
    await h.call('PUT', '/api/settings', { reviewIntensity: 'low' });
    expect((await h.call('GET', `/api/points/${item.knowledgePointId}`)).body.reviewCompleted).toBe(true);
    expect((await h.call('POST', '/api/relearn', { knowledgePointIds: [item.knowledgePointId] })).status).toBe(200);
    expect((await h.call('GET', `/api/points/${item.knowledgePointId}`)).body).toMatchObject({ stage: 'understand', reviewCompleted: false });
    expect(loadStates(h.db).get(item.knowledgePointId)!.reviewProgress!.attemptCount).toBe(0);
  });

  it('作废和改判都还原巩固证据，不让错误记录污染结束条件', async () => {
    const { h, session, item } = await start();
    const wrongId = await answer(h, session, item, 'wrong');
    expect((await h.call('POST', `/api/attempts/${wrongId}/appeal`, { reason: APPEAL_VOID_MARK })).body.outcome).toBe('void');
    expect(loadStates(h.db).get(item.knowledgePointId)!.reviewProgress!.attemptCount).toBe(0);
    await finish(h, session);
    const next = (await h.call('POST', '/api/sessions/next')).body.session;
    const retry = next.items.find((entry: any) => entry.knowledgePointId === item.knowledgePointId);
    const againId = await answer(h, next, retry, 'wrong');
    expect((await h.call('POST', `/api/attempts/${againId}/appeal`, { reason: APPEAL_ACCEPT_MARK })).body.outcome).toBe('accepted');
    await h.call('POST', `/api/attempts/${againId}/rating`, { selfRating: 'easy' });
    expect((await h.call('GET', `/api/points/${item.knowledgePointId}`)).body.reviewCompleted).toBe(true);
  });

  it('切到低档会重备尚未开始的题目，同档保存不重复作废', async () => {
    const h = createHarness();
    await h.startTopic();
    expect(loadPool(h.db).some((entry) => entry.questionForm === 'short_answer')).toBe(true);
    await h.call('PUT', '/api/settings', { reviewIntensity: 'low' });
    expect(loadPool(h.db)).toHaveLength(0);
    await h.worker.runUntilIdle();
    const pool = loadPool(h.db);
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.every((entry) => entry.questionForm === 'mcq')).toBe(true);
    await h.call('PUT', '/api/settings', { reviewIntensity: 'low' });
    expect(loadPool(h.db)).toEqual(pool);
    expect(loadPoints(h.db).every((point) => !point.excluded)).toBe(true);
  });

  it('生成过程中切换强度，旧强度的结果不会进入候选池', async () => {
    const h = createHarness();
    await h.startTopic();
    await h.call('PUT', '/api/settings', { tutorialGuidance: '结合具体案例重新讲解' });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const model: StructuredModel = {
      async generate<T>(request: StructuredRequest<T>): Promise<T> {
        entered();
        await blocked;
        return h.model.generate(request);
      },
    };
    const pending = fillPool({ db: h.db, model, settings: settingsSource(h.db, {}), clock: () => DAY1, illustrations: false }, DAY1);
    await started;
    try {
      await h.call('PUT', '/api/settings', { reviewIntensity: 'low' });
    } finally {
      release();
    }
    expect((await pending).generated).toBe(0);
    expect(loadPool(h.db)).toHaveLength(0);
    await h.worker.runUntilIdle();
    expect(loadPool(h.db).length).toBeGreaterThan(0);
    expect(loadPool(h.db).every((entry) => entry.questionForm === 'mcq')).toBe(true);
  });

  it('旧记录缺少最后一次作答时，不能用更早的轻松成绩结束复习', async () => {
    const { h, session, item } = await start('high');
    await answer(h, session, item, 'easy');
    await finish(h, session);
    const next = await review(h, item.knowledgePointId);
    const latestId = await answer(h, next.session, next.item, 'wrong', next.now);
    h.db.delete(attempts).where(eq(attempts.id, latestId)).run();
    h.db.update(memoryStates).set({ reviewProgress: null }).where(eq(memoryStates.knowledgePointId, item.knowledgePointId)).run();
    await h.call('PUT', '/api/settings', { reviewIntensity: 'low' });
    expect((await h.call('GET', `/api/points/${item.knowledgePointId}`)).body.reviewCompleted).toBe(false);
  });
});
