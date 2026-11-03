import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { PoolItem } from '../domain/assemble';
import type { GraphPoint } from '../domain/edge';
import { type MemoryState, reviveCard } from '../domain/memory';
import { EMPTY_REVIEW_PROGRESS, UNCONFIRMED_REVIEW_PROGRESS, nextReviewProgress } from '../domain/review';
import type { ConnectionContent, Graph, LessonContent, ReviewContent } from '../shared/content';
import type { TopicBrief } from '../shared/topic-planning';
import type { Executor } from './db';
import { attempts, existingKnowledge, items, knowledgePoints, memoryStates, relations, sessions, topics } from './schema';

// ---------- 学习主题与知识图谱 ----------

export function createTopic(db: Executor, title: string, now: Date, learningBrief?: TopicBrief): string {
  const id = randomUUID();
  db.insert(topics).values({ id, title, learningBrief, createdAt: now }).run();
  return id;
}

export function getTopic(db: Executor, id: string) {
  return db.select().from(topics).where(eq(topics.id, id)).get();
}

export function markGraphFailed(db: Executor, topicId: string): void {
  db.update(topics).set({ graphStatus: 'failed' }).where(eq(topics.id, topicId)).run();
}

/** 保存骨架图谱：知识点、关系，以及每个知识点的初始记忆状态（未学）。 */
export function saveGraph(db: Executor, topicId: string, graph: Graph, now: Date): void {
  db.transaction((tx) => {
    const idOf = new Map(graph.knowledgePoints.map((k) => [k.key, randomUUID()]));
    graph.knowledgePoints.forEach((k, position) => {
      const id = idOf.get(k.key)!;
      tx.insert(knowledgePoints).values({ id, topicId, title: k.title, summary: k.summary, position }).run();
      tx.insert(memoryStates).values({ knowledgePointId: id, stage: 'unlearned', updatedAt: now }).run();
    });
    for (const r of graph.relations) {
      tx.insert(relations).values({ fromId: idOf.get(r.from)!, toId: idOf.get(r.to)!, type: r.type }).run();
    }
    tx.update(topics).set({ graphStatus: 'ready' }).where(eq(topics.id, topicId)).run();
  });
}

/**
 * 把新知识点挂进知识图谱并初始化为未学，排在锚点知识点的推荐位置上。
 * prerequisite 为 true 的作为锚点的前置（学懂锚点之前要先学它），否则只作为同主题的知识点。
 * 用于拆解（更基础的前置）和从提问中整理出的知识。新知识点没有指向它的前置，不会形成环。
 */
export function addPoints(
  db: Executor,
  anchor: { id: string; topicId: string; position: number },
  points: { title: string; summary: string; prerequisite: boolean }[],
  origin: 'decomposed' | 'asked',
  now: Date,
): string[] {
  return db.transaction((tx) =>
    points.map((p) => {
      const id = randomUUID();
      tx.insert(knowledgePoints)
        .values({ id, topicId: anchor.topicId, title: p.title, summary: p.summary, position: anchor.position, origin })
        .run();
      tx.insert(memoryStates).values({ knowledgePointId: id, stage: 'unlearned', updatedAt: now }).run();
      if (p.prerequisite) tx.insert(relations).values({ fromId: id, toId: anchor.id, type: 'prerequisite' }).run();
      return id;
    }),
  );
}

/** 知识点及生成内容时需要的上下文 */
export interface PointInfo extends GraphPoint {
  topicId: string;
  excluded: boolean;
  topicTitle: string;
  learningBrief?: TopicBrief | null;
  title: string;
  summary: string;
  confusableIds: string[];
  /** 组成关系中，它是哪些知识点的一部分 */
  partOfIds: string[];
  /** 来源：骨架图谱、拆解、从提问中加入 */
  origin: 'graph' | 'decomposed' | 'asked';
}

/**
 * 加载所有图谱已生成的主题的知识点。暂停的主题也加载：它的复习照常进行，只是不新学
 * （learnable 为 false）；摸底诊断还没做完的主题同样不新学。
 */
export function loadPoints(db: Executor): PointInfo[] {
  const rows = db
    .select({ point: knowledgePoints, topic: topics, excluded: memoryStates.excluded })
    .from(knowledgePoints)
    .innerJoin(topics, eq(knowledgePoints.topicId, topics.id))
    .innerJoin(memoryStates, eq(knowledgePoints.id, memoryStates.knowledgePointId))
    .where(eq(topics.graphStatus, 'ready'))
    .all();
  const allRelations = db.select().from(relations).all();
  return rows.map(({ point, topic, excluded }) => ({
    id: point.id,
    excluded,
    position: point.position,
    topicId: point.topicId,
    topicTitle: topic.title,
    learningBrief: topic.learningBrief,
    learnable: topic.status === 'active' && (topic.placementStatus === 'done' || topic.placementStatus === 'skipped'),
    decomposed: point.origin === 'decomposed',
    origin: point.origin,
    title: point.title,
    summary: point.summary,
    prerequisiteIds: allRelations.filter((r) => r.type === 'prerequisite' && r.toId === point.id).map((r) => r.fromId),
    confusableIds: allRelations
      .filter((r) => r.type === 'confusable' && (r.fromId === point.id || r.toId === point.id))
      .map((r) => (r.fromId === point.id ? r.toId : r.fromId)),
    partOfIds: allRelations.filter((r) => r.type === 'composition' && r.fromId === point.id).map((r) => r.toId),
  }));
}

export function loadExistingKnowledge(db: Executor) {
  return db.select().from(existingKnowledge).all();
}

// ---------- 记忆状态 ----------

export function loadStates(db: Executor): Map<string, MemoryState> {
  const rows = db.select().from(memoryStates).all();
  const states = new Map(rows.map((r) => [r.knowledgePointId, rowToState(r)]));
  const legacyIds = rows.filter((row) => row.reviewProgress === null && states.get(row.knowledgePointId)!.card !== null).map((row) => row.knowledgePointId);
  if (legacyIds.length === 0) return states;

  // 一次加载旧记录，按当前记忆卡的作答次数限定本轮学习，避免复用重新学习前的成绩。
  const records = db.select({ pointId: items.knowledgePointId, form: items.questionForm, attempt: attempts, timeZone: sessions.timeZone })
    .from(attempts)
    .innerJoin(items, eq(items.id, attempts.itemId))
    .innerJoin(sessions, eq(sessions.id, attempts.sessionId))
    .where(and(inArray(items.knowledgePointId, legacyIds), eq(attempts.applied, true), eq(attempts.voided, false), ne(items.kind, 'connection')))
    .orderBy(asc(attempts.createdAt), sql`attempts.rowid`)
    .all();
  const byPoint = new Map<string, typeof records>();
  for (const record of records) {
    const own = byPoint.get(record.pointId) ?? [];
    own.push(record);
    byPoint.set(record.pointId, own);
  }
  for (const id of legacyIds) {
    const state = states.get(id)!;
    const count = state.card!.reps;
    const own = count > 0 ? (byPoint.get(id) ?? []).slice(-count) : [];
    const latestBefore = own.at(-1)?.attempt.stateBefore as MemoryState | null | undefined;
    // 有缺失记录或无法确认最后一次作答时，不用旧成绩推断已经完成。
    if (own.length !== count || !latestBefore || (latestBefore.card?.reps ?? 0) !== count - 1) continue;
    const before = own[0]?.attempt.stateBefore as MemoryState | null | undefined;
    let progress = UNCONFIRMED_REVIEW_PROGRESS;
    if (before?.reviewProgress) progress = before.reviewProgress;
    else if (before?.stage === 'unlearned' || before?.stage === 'inferred') progress = EMPTY_REVIEW_PROGRESS;
    for (const { attempt, form, timeZone } of own) {
      if (attempt.correct && attempt.selfRating === null) {
        progress = UNCONFIRMED_REVIEW_PROGRESS;
        continue;
      }
      const outcome = attempt.correct
        ? { correct: true as const, selfRating: attempt.selfRating! }
        : { correct: false as const };
      progress = nextReviewProgress(progress, form, outcome, attempt.createdAt, timeZone ?? 'UTC');
    }
    state.reviewProgress = progress;
  }
  return states;
}

function rowToState(r: typeof memoryStates.$inferSelect): MemoryState {
  return {
    stage: r.stage,
    card: reviveCard(r.card),
    lastExplainForm: r.lastExplainForm,
    lastQuestionForm: r.lastQuestionForm,
    failStreak: r.failStreak,
    pendingContrast: r.pendingContrast,
    lastMisconception: r.lastMisconception,
    reviewProgress: r.reviewProgress ?? ((r.stage === 'unlearned' || r.stage === 'inferred') ? EMPTY_REVIEW_PROGRESS : UNCONFIRMED_REVIEW_PROGRESS),
  };
}

export function saveState(db: Executor, knowledgePointId: string, state: MemoryState, now: Date): void {
  db.update(memoryStates)
    .set({
      stage: state.stage,
      card: state.card,
      lastExplainForm: state.lastExplainForm,
      lastQuestionForm: state.lastQuestionForm,
      failStreak: state.failStreak,
      pendingContrast: state.pendingContrast,
      lastMisconception: state.lastMisconception,
      reviewProgress: state.reviewProgress ?? null,
      updatedAt: now,
    })
    .where(eq(memoryStates.knowledgePointId, knowledgePointId))
    .run();
}

/** 是否已经拆解过：每个知识点只拆解一次 */
export function wasDecomposed(db: Executor, knowledgePointId: string): boolean {
  const row = db.select({ at: memoryStates.decomposedAt }).from(memoryStates).where(eq(memoryStates.knowledgePointId, knowledgePointId)).get();
  return row?.at != null;
}

export function markDecomposed(db: Executor, knowledgePointId: string, now: Date): void {
  db.update(memoryStates).set({ decomposedAt: now, failStreak: 0 }).where(eq(memoryStates.knowledgePointId, knowledgePointId)).run();
}

// ---------- 候选池 ----------

export type ItemContent = LessonContent | ReviewContent | ConnectionContent;

export function insertItem(
  db: Executor,
  item: { knowledgePointId: string; kind: 'lesson' | 'review' | 'connection'; form: string; questionForm: string; estSeconds: number; content: ItemContent; status?: 'pooled' | 'used' },
  now: Date,
): string {
  const id = randomUUID();
  db.insert(items).values({ id, ...item, createdAt: now }).run();
  return id;
}

/** 候选池中可用的内容（联结练习不进候选池，开始一节时现做） */
export function loadPool(db: Executor): PoolItem[] {
  return db
    .select({
      id: items.id,
      knowledgePointId: items.knowledgePointId,
      kind: items.kind,
      form: items.form,
      questionForm: items.questionForm,
      estSeconds: items.estSeconds,
    })
    .from(items)
    .where(eq(items.status, 'pooled'))
    .all()
    .filter((i): i is PoolItem => i.kind !== 'connection');
}

export function getItems(db: Executor, ids: string[]) {
  if (ids.length === 0) return [];
  return db.select().from(items).where(inArray(items.id, ids)).all();
}

export function markItemsUsed(db: Executor, ids: string[]): void {
  if (ids.length === 0) return;
  db.update(items).set({ status: 'used' }).where(inArray(items.id, ids)).run();
}
