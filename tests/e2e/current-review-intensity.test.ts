import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { StructuredRequest } from '../../src/ai/gateway';
import { fillPool } from '../../src/jobs/fill-pool';
import { settingsSource } from '../../src/settings';
import { loadPoints, loadStates } from '../../src/store/repo';
import { attempts, illustrations, items } from '../../src/store/schema';
import { CORRECT_MARK, MCQ, createFakeIllustrator } from '../fixtures/fake-model';
import { DAY1, createHarness } from '../fixtures/harness';

type Harness = ReturnType<typeof createHarness>;

async function start(intensity: 'high' | 'low' = 'high') {
  const h = createHarness();
  await h.call('PUT', '/api/settings', { reviewIntensity: intensity });
  await h.startTopic();
  const session = (await h.call('POST', '/api/sessions/next')).body.session;
  return { h, session };
}

async function submit(h: Harness, session: any, item: any, now = DAY1) {
  const result = await h.call('POST', '/api/attempts', {
    sessionId: session.id, itemId: item.id,
    answer: item.question.type === 'mcq' ? { choice: MCQ.answerIndex } : { text: CORRECT_MARK },
  }, now);
  expect(result.status).toBe(201);
  return result.body.attemptId as string;
}

async function startReview(intensity: 'high' | 'low' = 'high', rating = 'good') {
  const { h, session } = await start(intensity);
  const first = session.items[0];
  const id = await submit(h, session, first);
  await h.call('POST', `/api/attempts/${id}/rating`, { selfRating: rating });
  await h.call('POST', `/api/sessions/${session.id}/finish`);
  const now = loadStates(h.db).get(first.knowledgePointId)!.card!.due;
  await fillPool({ db: h.db, model: h.model, settings: settingsSource(h.db, {}), clock: () => now, illustrations: false }, now);
  const next = (await h.call('POST', '/api/sessions/next', undefined, now)).body.session;
  const item = next.items.find((entry: any) => entry.knowledgePointId === first.knowledgePointId);
  return { h, session: next, item, now };
}

describe('把复习强度应用到本次课程', () => {
  it('不勾选时保持本节不变；勾选后原课程中未作答的小题换成选择题，讲解保留', async () => {
    const { h, session } = await start();
    const before = session.items.find((item: any) => item.question?.type === 'short_answer');
    expect(before).toBeDefined();
    await h.call('PUT', '/api/settings', { reviewIntensity: 'low' });
    expect((await h.call('POST', '/api/sessions/next')).body.session).toEqual(session);
    expect((await h.call('PUT', '/api/settings', { reviewIntensity: 'low', applyToCurrentSession: true })).status).toBe(200);
    const after = (await h.call('POST', '/api/sessions/next')).body.session;
    expect(after).toMatchObject({ id: session.id, reviewIntensity: 'low' });
    expect(after.items.every((item: any) => !item.question || item.question.type === 'mcq')).toBe(true);
    const replacement = after.items.find((item: any) => item.knowledgePointId === before.knowledgePointId);
    expect(replacement.id).not.toBe(before.id);
    expect(replacement.explanation).toBe(before.explanation);
    expect((await h.call('GET', '/api/settings')).body.settings).not.toHaveProperty('applyToCurrentSession');
  });

  it('已提交但未自评的题目和记录原样保留，自评仍按提交时的高档规则处理', async () => {
    const { h, session, item, now } = await startReview();
    const id = await submit(h, session, item, now);
    const before = h.db.select().from(attempts).where(eq(attempts.id, id)).get();
    const original = (await h.call('POST', '/api/sessions/next', undefined, now)).body.session.items.find((entry: any) => entry.id === item.id);
    expect((await h.call('PUT', '/api/settings', { reviewIntensity: 'low', applyToCurrentSession: true }, now)).status).toBe(200);
    const updated = (await h.call('POST', '/api/sessions/next', undefined, now)).body.session;
    expect(updated.reviewIntensity).toBe('low');
    expect(updated.items.find((entry: any) => entry.id === item.id)).toEqual(original);
    expect(h.db.select().from(attempts).where(eq(attempts.id, id)).get()).toEqual(before);
    await h.call('POST', `/api/attempts/${id}/rating`, { selfRating: 'easy' }, now);
    expect(loadStates(h.db).get(item.knowledgePointId)!.stage).toBe('apply');
  });

  it('低档本节切到高档后，未作答的复习恢复混合题型', async () => {
    const { h, session, item, now } = await startReview('low');
    expect(item.question.type).toBe('mcq');
    expect((await h.call('PUT', '/api/settings', { reviewIntensity: 'high', applyToCurrentSession: true }, now)).status).toBe(200);
    const updated = (await h.call('POST', '/api/sessions/next', undefined, now)).body.session;
    expect(updated).toMatchObject({ id: session.id, reviewIntensity: 'high' });
    expect(updated.items.find((entry: any) => entry.knowledgePointId === item.knowledgePointId).question.type).toBe('short_answer');
  });

  it('低档已经提交的选择题，切到高档再自评也不会升级应用能力', async () => {
    const { h, session, item, now } = await startReview('low');
    const id = await submit(h, session, item, now);
    expect((await h.call('PUT', '/api/settings', { reviewIntensity: 'high', applyToCurrentSession: true }, now)).status).toBe(200);
    await h.call('POST', `/api/attempts/${id}/rating`, { selfRating: 'easy' }, now);
    expect(loadStates(h.db).get(item.knowledgePointId)!.stage).toBe('recall');
  });

  it('更换小题保留原插画，失败的插画仍能重试', async () => {
    const { illustrator } = createFakeIllustrator({ alwaysFail: true });
    const h = createHarness({ illustrator });
    await h.startTopic();
    const session = (await h.call('POST', '/api/sessions/next')).body.session;
    const lesson = session.items.find((entry: any) => entry.question?.type === 'short_answer');
    const image = h.db.select().from(illustrations).where(eq(illustrations.itemId, lesson.id)).get()!;
    expect(image.status).toBe('failed');
    expect((await h.call('PUT', '/api/settings', { reviewIntensity: 'low', applyToCurrentSession: true })).status).toBe(200);
    const updated = (await h.call('POST', '/api/sessions/next')).body.session;
    const replacement = updated.items.find((entry: any) => entry.knowledgePointId === lesson.knowledgePointId);
    expect(replacement.explanation).toBe(lesson.explanation);
    expect(h.db.select().from(illustrations).where(eq(illustrations.id, image.id)).get()!.itemId).toBe(replacement.id);
    expect((await h.call('POST', `/api/illustrations/${image.id}/retry`)).status).toBe(200);
  });

  it('高档本节切到低档后，已完成轻量巩固的未作答复习移出课程', async () => {
    const { h, session, item, now } = await startReview('high', 'easy');
    const state = loadStates(h.db).get(item.knowledgePointId);
    expect((await h.call('PUT', '/api/settings', { reviewIntensity: 'low', applyToCurrentSession: true }, now)).status).toBe(200);
    const updated = (await h.call('POST', '/api/sessions/next', undefined, now)).body.session;
    expect(updated.id).toBe(session.id);
    expect(updated.items.some((entry: any) => entry.id === item.id)).toBe(false);
    expect(loadStates(h.db).get(item.knowledgePointId)).toEqual(state);
    expect((await h.call('GET', `/api/points/${item.knowledgePointId}`)).body.records).toHaveLength(1);
  });

  it('重新出题失败时保留原课程和原设置，不留下半次修改', async () => {
    const { h, session } = await start();
    const oldItems = h.db.select().from(items).all();
    h.model.generate = async () => { throw new Error('测试生成失败'); };
    const result = await h.call('PUT', '/api/settings', { reviewIntensity: 'low', applyToCurrentSession: true });
    expect(result.status).toBe(502);
    expect((await h.call('GET', '/api/settings')).body.settings.reviewIntensity).toBe('high');
    expect((await h.call('POST', '/api/sessions/next')).body.session).toEqual(session);
    expect(h.db.select().from(items).all()).toEqual(oldItems);
  });

  it('生成期间课程被结束时拒绝覆盖，也不修改后来开始的课程', async () => {
    const { h, session } = await start();
    let reached!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const generate = h.model.generate;
    h.model.generate = async <T>(request: StructuredRequest<T>): Promise<T> => {
      reached();
      await gate;
      return generate(request);
    };
    const pending = h.call('PUT', '/api/settings', { reviewIntensity: 'low', applyToCurrentSession: true });
    await entered;
    try {
      await h.call('POST', `/api/sessions/${session.id}/finish`);
    } finally {
      release();
    }
    expect((await pending).status).toBe(409);
    expect((await h.call('GET', '/api/settings')).body.settings.reviewIntensity).toBe('high');
  });

  it('没有进行中的课程时正常保存；应用范围只允许随复习强度一起提交', async () => {
    const h = createHarness();
    expect((await h.call('PUT', '/api/settings', { reviewIntensity: 'low', applyToCurrentSession: true })).status).toBe(200);
    expect((await h.call('GET', '/api/sessions/preview')).body.open).toBeNull();
    expect((await h.call('PUT', '/api/settings', { sessionMinutes: 15, applyToCurrentSession: true })).status).toBe(400);
    expect((await h.call('PUT', '/api/settings', { reviewIntensity: 'high', applyToCurrentSession: 'yes' })).status).toBe(400);
  });

  it('本节只剩无需复习的内容时可以变为空，仍保留同一课堂供用户完成', async () => {
    const { h, session } = await start();
    const first = session.items[0];
    const id = await submit(h, session, first);
    await h.call('POST', `/api/attempts/${id}/rating`, { selfRating: 'easy' });
    await h.call('POST', `/api/sessions/${session.id}/finish`);
    for (const point of loadPoints(h.db)) {
      if (point.id !== first.knowledgePointId) await h.call('PATCH', `/api/points/${point.id}/learning`, { excluded: true });
    }
    const now = loadStates(h.db).get(first.knowledgePointId)!.card!.due;
    await fillPool({ db: h.db, model: h.model, settings: settingsSource(h.db, {}), clock: () => now, illustrations: false }, now);
    const current = (await h.call('POST', '/api/sessions/next', undefined, now)).body.session;
    expect(current.items).toHaveLength(1);
    expect((await h.call('PUT', '/api/settings', { reviewIntensity: 'low', applyToCurrentSession: true }, now)).status).toBe(200);
    expect((await h.call('POST', '/api/sessions/next', undefined, now)).body.session).toMatchObject({ id: current.id, items: [] });
    expect((await h.call('POST', `/api/sessions/${current.id}/finish`, undefined, now)).status).toBe(200);
  });

  it('升级旧作答记录时沿用各自课堂的强度，不把低档作答改成高档', () => {
    const db = new Database(':memory:');
    try {
      db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, review_intensity TEXT NOT NULL); CREATE TABLE attempts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);");
      db.exec("INSERT INTO sessions VALUES ('s1', 'low'), ('s2', 'high'); INSERT INTO attempts VALUES ('a1', 's1'), ('a2', 's2');");
      db.exec(readFileSync(new URL('../../src/store/migrations/0009_attempt_review_intensity.sql', import.meta.url), 'utf8'));
      expect(db.prepare('SELECT id, review_intensity FROM attempts ORDER BY id').all()).toEqual([
        { id: 'a1', review_intensity: 'low' }, { id: 'a2', review_intensity: 'high' },
      ]);
    } finally {
      db.close();
    }
  });
});
