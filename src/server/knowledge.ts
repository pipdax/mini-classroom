import { randomUUID } from 'node:crypto';
import { type SQL, and, asc, desc, eq, gte, inArray, isNull, lt, or } from 'drizzle-orm';
import { chunksOf } from '../domain/chunks';
import { masteryOf } from '../domain/mastery';
import { cognitiveEdge } from '../domain/edge';
import { type Stage, UNLEARNED, hasLearned, isDue, needsDecomposition, relearn, reviewCompleted, reviewDueAt } from '../domain/memory';
import type { Settings } from '../settings';
import type { CheatsheetScope } from '../jobs/handlers';
import { enqueue } from '../jobs/queue';
import type { Db } from '../store/db';
import { getTopic, loadExistingKnowledge, loadPoints, loadStates, saveState, wasDecomposed } from '../store/repo';
import { attempts, cheatsheets, connections, existingKnowledge, items, knowledgePoints, memoryStates, relations, sessionItems, sessions, topics } from '../store/schema';
import { LearningError, dayFormatter, dayRange, toRecord } from './views';

export interface KnowledgeDeps {
  db: Db;
  settings: () => Settings;
}

const STAGE_LABEL: Record<Stage, string> = {
  unlearned: '未学',
  inferred: '推断掌握',
  understand: '理解',
  recall: '回忆',
  apply: '应用',
  retain: '保持',
};

/** 认知地图、作答留档、按天回看、重新学习、已有知识、速查表与导出 */
export function createKnowledge({ db, settings }: KnowledgeDeps) {
  /**
   * 认知地图：一张图覆盖所有学习主题。每个知识点带掌握阶段；认知边缘高亮（下一步可学）；
   * 未学且不在边缘的被迷雾覆盖；同一整体的部分全部进入保持阶段后合并为组块；联结带用户原话。
   */
  function cognitiveMap(now: Date) {
    const intensity = settings().reviewIntensity;
    const points = loadPoints(db);
    const states = loadStates(db);
    const stageOf = (id: string) => (states.get(id) ?? UNLEARNED).stage;
    const edgeIds = new Set(cognitiveEdge(points, states).map((p) => p.id));
    const excludedIds = new Set(points.filter((p) => p.excluded).map((p) => p.id));
    const compositions = db.select().from(relations).where(eq(relations.type, 'composition')).all();
    const known = loadExistingKnowledge(db);
    const allTopics = db.select().from(topics).orderBy(asc(topics.createdAt)).all();

    return {
      generatedAt: now,
      topics: allTopics.map((t) => {
        const own = points.filter((p) => p.topicId === t.id);
        return {
          ...t,
          total: own.length,
          excluded: own.filter((p) => p.excluded).length,
          learned: own.filter((p) => hasLearned(stageOf(p.id))).length,
          edge: own.filter((p) => edgeIds.has(p.id)).length,
          due: own.filter((p) => !p.excluded && isDue(states.get(p.id) ?? UNLEARNED, now, intensity)).length,
        };
      }),
      points: points
        .sort((a, b) => a.position - b.position)
        .map((p) => {
          const state = states.get(p.id) ?? UNLEARNED;
          return {
            id: p.id,
            topicId: p.topicId,
            title: p.title,
            summary: p.summary,
            excluded: p.excluded,
            stage: state.stage,
            stageLabel: STAGE_LABEL[state.stage],
            onEdge: edgeIds.has(p.id),
            // 迷雾：能新学的主题里，前置还没学会的未学知识点。主题暂停或摸底未完成时，未学的只显示为未学
            fog: !p.excluded && state.stage === 'unlearned' && !edgeIds.has(p.id) && p.learnable !== false,
            mastery: masteryOf(state),
            decomposed: p.decomposed ?? false,
            origin: p.origin,
            nextReviewAt: p.excluded ? null : reviewDueAt(state, intensity),
            reviewCompleted: !p.excluded && reviewCompleted(state, intensity),
            prerequisiteIds: p.prerequisiteIds,
            confusableIds: p.confusableIds,
            partOfIds: p.partOfIds,
          };
        }),
      chunks: chunksOf(new Map(points.map((p) => [p.id, stageOf(p.id)])), compositions)
        .filter((chunk) => !excludedIds.has(chunk.wholeId) && chunk.partIds.every((id) => !excludedIds.has(id))),
      connections: db
        .select()
        .from(connections)
        .orderBy(desc(connections.createdAt))
        .all()
        .map((c) => ({
          id: c.id,
          fromPointId: c.fromPointId,
          toPointId: c.toPointId,
          toExisting: c.toExistingId ? (known.find((k) => k.id === c.toExistingId) ?? null) : null,
          quote: c.quote,
          relation: c.relation,
          createdAt: c.createdAt,
        })),
      existingKnowledge: known,
    };
  }

  /** 一个知识点的详情：掌握阶段、全部作答留档（含申诉结果）、与它相关的联结 */
  function pointDetail(pointId: string) {
    const intensity = settings().reviewIntensity;
    const point = loadPoints(db).find((p) => p.id === pointId);
    if (!point) throw new LearningError('知识点不存在', 404);
    const state = loadStates(db).get(pointId) ?? UNLEARNED;
    const records = loadRecords(eq(items.knowledgePointId, pointId)).map(toRecord);
    return {
      id: point.id,
      topicId: point.topicId,
      topicTitle: point.topicTitle,
      title: point.title,
      summary: point.summary,
      excluded: point.excluded,
      stage: state.stage,
      stageLabel: STAGE_LABEL[state.stage],
      nextReviewAt: point.excluded ? null : reviewDueAt(state, intensity),
      reviewCompleted: !point.excluded && reviewCompleted(state, intensity),
      canRelearn: !point.excluded && hasLearned(state.stage),
      records,
    };
  }

  /** 设置是否学习，只改变学习选择；恢复后沿用原来的阶段、复习参数和作答记录。 */
  function setLearningExcluded(pointId: string, excluded: boolean, now: Date) {
    const state = db.select().from(memoryStates).where(eq(memoryStates.knowledgePointId, pointId)).get();
    if (!state) throw new LearningError('知识点不存在', 404);
    if (state.excluded !== excluded) {
      db.transaction((tx) => {
        tx.update(memoryStates).set({ excluded }).where(eq(memoryStates.knowledgePointId, pointId)).run();
        if (!excluded && needsDecomposition(loadStates(tx).get(pointId)!) && !wasDecomposed(tx, pointId)) {
          enqueue(tx, 'decompose', { knowledgePointId: pointId }, now);
        }
        // 不学可能放行后续知识点，恢复也可能需要补课，两种变化都重新检查候选池
        enqueue(tx, 'fill_pool', { now: now.toISOString() }, now, { dedupe: true });
      });
    }
    return { id: pointId, excluded };
  }

  /**
   * 按天回看：有学习记录的日子（按用户所在时区划分），最近的在前。
   * 指定主题时只算这个主题的知识点。
   */
  function reviewDays(input: { timeZone: string; topicId?: string }) {
    if (input.topicId && !getTopic(db, input.topicId)) throw new LearningError('学习主题不存在', 404);
    const dayOf = dayFormatter(input.timeZone);
    const rows = db
      .select({ at: attempts.createdAt, knowledgePointId: items.knowledgePointId })
      .from(attempts)
      .innerJoin(items, eq(attempts.itemId, items.id))
      .innerJoin(knowledgePoints, eq(items.knowledgePointId, knowledgePoints.id))
      .where(input.topicId ? eq(knowledgePoints.topicId, input.topicId) : undefined)
      .all();
    const pointsByDay = new Map<string, Set<string>>();
    for (const row of rows) {
      const day = dayOf(row.at);
      pointsByDay.set(day, (pointsByDay.get(day) ?? new Set()).add(row.knowledgePointId));
    }
    return [...pointsByDay]
      .map(([day, pointIds]) => ({ day, pointCount: pointIds.size }))
      .sort((a, b) => b.day.localeCompare(a.day));
  }

  /** 按天回看：那一天的全部作答留档（讲解、题目、回答、批改），按当时的先后顺序 */
  function dayReview(input: { day: string; timeZone: string; topicId?: string }) {
    const topic = input.topicId ? getTopic(db, input.topicId) : null;
    if (input.topicId && !topic) throw new LearningError('学习主题不存在', 404);
    const dayOf = dayFormatter(input.timeZone);
    // 先按 UTC 前后各放宽 14 小时（覆盖所有时区）粗筛，再按用户时区精确判断是不是这一天
    const { from, to } = dayRange(input.day);
    const range = and(gte(attempts.createdAt, from), lt(attempts.createdAt, to));
    const rows = loadRecords(input.topicId ? and(range, eq(knowledgePoints.topicId, input.topicId)) : range).filter(
      (row) => dayOf(row.attempt.createdAt) === input.day,
    );
    const states = loadStates(db);
    return {
      day: input.day,
      topic: topic ?? null,
      entries: rows.map((row) => ({
        topicTitle: row.topicTitle,
        point: { id: row.point.id, title: row.point.title, stage: (states.get(row.point.id) ?? UNLEARNED).stage },
        record: toRecord(row),
      })),
    };
  }

  /**
   * 重新学习一批知识点：已学过的退回理解阶段，由下一节微课堂换一种讲法重讲。
   * 还没学会的（未学、理解阶段）本来就会被讲解，跳过。
   * 知识点还在未完成的一节里等作答或自评时拒绝，避免那一项作答后无法按原阶段更新。
   */
  function relearnPoints(knowledgePointIds: string[], now: Date) {
    const states = loadStates(db);
    const missing = knowledgePointIds.filter((id) => !states.has(id));
    if (missing.length > 0) throw new LearningError('知识点不存在', 404);
    const targets = knowledgePointIds.filter((id) => hasLearned(states.get(id)!.stage));

    const busy = pendingInOpenSession(targets);
    if (busy.length > 0) throw new LearningError('有知识点还在未完成的一节微课堂里，先完成那一节再重新学习', 409);

    db.transaction((tx) => {
      for (const id of targets) {
        saveState(tx, id, relearn(states.get(id)!), now);
        tx.update(memoryStates).set({ excluded: false }).where(eq(memoryStates.knowledgePointId, id)).run();
      }
    });
    // 理解阶段需要一项新的讲解，后台补进候选池
    if (targets.length > 0) enqueue(db, 'fill_pool', { now: now.toISOString() }, now, { dedupe: true });
    return { relearned: targets };
  }

  // ---------- 已有知识 ----------

  function addExistingKnowledge(text: string, now: Date) {
    const id = randomUUID();
    db.insert(existingKnowledge).values({ id, topicId: null, text, createdAt: now }).run();
    return { id, text };
  }

  /** 删除已有知识：已经有联结挂在它上面时不能删，否则联结会失去一端 */
  function removeExistingKnowledge(id: string) {
    const used = db.select({ id: connections.id }).from(connections).where(eq(connections.toExistingId, id)).get();
    if (used) throw new LearningError('已经有联结挂在这条已有知识上，不能删除', 409);
    db.delete(existingKnowledge).where(eq(existingKnowledge.id, id)).run();
    return { ok: true };
  }

  // ---------- 速查表 ----------

  /** 速查表默认只收录已进入应用或保持阶段的知识点 */
  const DEFAULT_CHEATSHEET_STAGES: Stage[] = ['apply', 'retain'];

  /** 按选定的认知地图范围生成速查表；后台生成，完成后可查看和导出 */
  function createCheatsheet(input: { topicIds: string[]; stages?: Stage[] }, now: Date) {
    const stages = input.stages && input.stages.length > 0 ? input.stages : DEFAULT_CHEATSHEET_STAGES;
    const chosen = db.select().from(topics).where(inArray(topics.id, input.topicIds)).all();
    if (chosen.length === 0) throw new LearningError('请选择至少一个学习主题', 400);
    const states = loadStates(db);
    const count = loadPoints(db).filter((p) => input.topicIds.includes(p.topicId) && stages.includes((states.get(p.id) ?? UNLEARNED).stage)).length;
    if (count === 0) {
      throw new LearningError(`选定范围里还没有处于${stages.map((s) => `"${STAGE_LABEL[s]}"`).join('或')}阶段的知识点`, 400);
    }
    const id = randomUUID();
    const title = `${chosen.map((t) => t.title).join('、')} 速查表`;
    const scope: CheatsheetScope = { topicIds: input.topicIds, stages };
    db.insert(cheatsheets).values({ id, title, scope, createdAt: now }).run();
    enqueue(db, 'generate_cheatsheet', { cheatsheetId: id }, now);
    return { id, title, pointCount: count };
  }

  function listCheatsheets() {
    return db
      .select({ id: cheatsheets.id, title: cheatsheets.title, status: cheatsheets.status, createdAt: cheatsheets.createdAt })
      .from(cheatsheets)
      .orderBy(desc(cheatsheets.createdAt))
      .all();
  }

  function getCheatsheet(id: string) {
    const sheet = db.select().from(cheatsheets).where(eq(cheatsheets.id, id)).get();
    if (!sheet) throw new LearningError('速查表不存在', 404);
    return sheet;
  }

  // ---------- 导出 ----------

  /**
   * 导出为 Markdown，只供用户本人使用：选定主题的知识点（含阶段、联结），可选附上作答记录和速查表。
   */
  function exportMarkdown(input: { topicIds: string[]; records: boolean; cheatsheetId?: string }, now: Date) {
    const intensity = settings().reviewIntensity;
    const chosen = db.select().from(topics).where(inArray(topics.id, input.topicIds)).orderBy(asc(topics.createdAt)).all();
    if (chosen.length === 0) throw new LearningError('请选择至少一个学习主题', 400);
    const points = loadPoints(db);
    const states = loadStates(db);
    const byId = new Map(points.map((p) => [p.id, p]));
    const known = new Map(loadExistingKnowledge(db).map((k) => [k.id, k.text]));
    const links = db.select().from(connections).all();
    const lines: string[] = [`# 微课堂导出`, '', `导出时间：${now.toISOString().slice(0, 16).replace('T', ' ')}（UTC）`, ''];

    for (const topic of chosen) {
      const own = points.filter((p) => p.topicId === topic.id).sort((a, b) => a.position - b.position);
      lines.push(`## ${topic.title}`, '');
      for (const p of own) {
        const state = states.get(p.id) ?? UNLEARNED;
        lines.push(`### ${p.title}`, '', `- 掌握阶段：${STAGE_LABEL[state.stage]}`, `- 要掌握的内容：${p.summary}`);
        if (p.excluded) lines.push('- 学习选择：不学（可重新加入学习）');
        const due = reviewDueAt(state, intensity);
        if (!p.excluded && reviewCompleted(state, intensity)) lines.push('- 复习安排：已完成轻量巩固');
        if (!p.excluded && due) lines.push(`- 下次复习：${due.toISOString().slice(0, 10)}`);
        for (const c of links.filter((l) => l.fromPointId === p.id || l.toPointId === p.id)) {
          const other = c.fromPointId === p.id ? (c.toPointId ? byId.get(c.toPointId)?.title : known.get(c.toExistingId ?? '')) : byId.get(c.fromPointId)?.title;
          lines.push(`- 联结「${other ?? ''}」：${c.relation}`, `  > ${c.quote.replace(/\n/g, '\n  > ')}`);
        }
        lines.push('');
        if (input.records) lines.push(...recordLines(p.id));
      }
    }

    if (input.cheatsheetId) {
      const sheet = getCheatsheet(input.cheatsheetId);
      if (sheet.markdown) lines.push('---', '', sheet.markdown, '');
    }
    return { filename: `微课堂-${now.toISOString().slice(0, 10)}.md`, markdown: lines.join('\n') };
  }

  /** 一个知识点的作答记录，写成 Markdown */
  function recordLines(pointId: string): string[] {
    const records = loadRecords(eq(items.knowledgePointId, pointId)).map(toRecord);
    if (records.length === 0) return [];
    const lines = ['#### 作答记录', ''];
    for (const r of records) {
      const verdict = r.voided ? '作废' : r.correct ? '答对' : '答错';
      lines.push(`- ${r.at.toISOString().slice(0, 16).replace('T', ' ')} · ${r.formLabel} · ${verdict}`);
      const answer = 'text' in r.answer ? r.answer.text : `第 ${r.answer.choice + 1} 项`;
      lines.push(`  - 我的作答：${answer.replace(/\n/g, ' ')}`);
      if (r.feedback) lines.push(`  - 批改：${r.feedback.replace(/\n/g, ' ')}`);
      if (r.appeal) lines.push(`  - 申诉：${r.appeal.reason}（${r.appeal.feedback}）`);
    }
    lines.push('');
    return lines;
  }

  // ---------- 内部 ----------

  /** 作答留档连同所属的内容、知识点和主题，按作答时间排序 */
  function loadRecords(filter: SQL | undefined) {
    return db
      .select({ attempt: attempts, item: items, point: knowledgePoints, topicTitle: topics.title })
      .from(attempts)
      .innerJoin(items, eq(attempts.itemId, items.id))
      .innerJoin(knowledgePoints, eq(items.knowledgePointId, knowledgePoints.id))
      .innerJoin(topics, eq(knowledgePoints.topicId, topics.id))
      .where(filter)
      .orderBy(asc(attempts.createdAt))
      .all();
  }

  /** 在未结束的一节里、还没按作答更新记忆状态的知识点 */
  function pendingInOpenSession(knowledgePointIds: string[]): string[] {
    if (knowledgePointIds.length === 0) return [];
    const rows = db
      .select({ knowledgePointId: items.knowledgePointId, applied: attempts.applied, kind: items.kind })
      .from(sessionItems)
      .innerJoin(sessions, eq(sessionItems.sessionId, sessions.id))
      .innerJoin(items, eq(sessionItems.itemId, items.id))
      .leftJoin(attempts, and(eq(attempts.sessionId, sessionItems.sessionId), eq(attempts.itemId, sessionItems.itemId)))
      .where(and(isNull(sessions.finishedAt), inArray(items.knowledgePointId, knowledgePointIds), or(eq(items.kind, 'lesson'), eq(items.kind, 'review'))))
      .all();
    return rows.filter((r) => !r.applied).map((r) => r.knowledgePointId);
  }

  return {
    cognitiveMap,
    pointDetail,
    setLearningExcluded,
    reviewDays,
    dayReview,
    relearnPoints,
    addExistingKnowledge,
    removeExistingKnowledge,
    createCheatsheet,
    listCheatsheets,
    getCheatsheet,
    exportMarkdown,
  };
}

export type Knowledge = ReturnType<typeof createKnowledge>;
