import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { Illustrator, StructuredModel } from '../ai/gateway';
import { generateReview, gradeConnection, gradeOpenAnswer, judgeAppeal } from '../ai/generators';
import { type PoolItem, assemble } from '../domain/assemble';
import { timeFactor } from '../domain/calibration';
import { cognitiveEdge, prerequisitesSatisfied } from '../domain/edge';
import { CONTRAST_FORM, type ExplainForm, type QuestionForm, isMobileForm, pickForm, questionFormsFor } from '../domain/forms';
import { gradeMcq, gradePickLine, misconceptionOf } from '../domain/grading';
import {
  DECOMPOSE_FAIL_STREAK,
  type MemoryState,
  type Outcome,
  type SelfRating,
  UNLEARNED,
  applyLessonOutcome,
  applyReviewOutcome,
  checkStageOf,
  hasLearned,
  hasSchedule,
  isDue,
  needsDecomposition,
  reviewCompleted,
} from '../domain/memory';
import { UNCONFIRMED_REVIEW_PROGRESS, type ReviewIntensity } from '../domain/review';
import type { PoolNeed } from '../domain/plan-pool';
import { chooseNewTopic, revisitDue } from '../domain/topics';
import { settleWithLimit } from '../jobs/concurrency';
import { fillPool } from '../jobs/fill-pool';
import { contextOf, generateItem, saveGeneratedItem } from '../jobs/generate-item';
import { enqueue } from '../jobs/queue';
import { type Settings, type UserSettings, readState, writeState } from '../settings';
import { type ConnectionContent, type Grade, type LessonContent, type Question, isOpenQuestion } from '../shared/content';
import { sameContentGuidance } from '../shared/content-guidance';
import type { Db } from '../store/db';
import {
  type PointInfo,
  createTopic,
  getItems,
  getTopic,
  insertItem,
  loadExistingKnowledge,
  loadPoints,
  loadPool,
  loadStates,
  markItemsUsed,
  saveState,
  wasDecomposed,
} from '../store/repo';
import { attempts, connections, illustrations, items, jobs, memoryStates, sessionItems, sessions, topics } from '../store/schema';
import {
  type Answer,
  type Appeal,
  type ItemRow,
  LearningError,
  SERVER_TIME_ZONE,
  dayFormatter,
  formLabel,
  itemBody,
  questionOf,
  reveal,
  stateFromJson,
} from './views';

export { type Answer, LearningError } from './views';

export interface LearningDeps {
  db: Db;
  model: StructuredModel;
  /** 每次读取最新设置：设置页改动后立即生效 */
  settings: () => Settings;
  /** 按当前配置取画插画的模型；没有配置（或不传）时讲解只用代码画的图 */
  illustrator?: () => Illustrator | undefined;
}

/** 这一项在本节中的用途 */
export type ItemPurpose = (typeof sessionItems.$inferSelect)['purpose'];

export interface NextSessionOptions {
  /** 补充说明：按它重新生成本节内容 */
  guidance?: string;
  device?: 'desktop' | 'mobile';
  /** 用户所在时区，用于判断"今天"已学了几节 */
  timeZone?: string;
  /** 构建新一节：提前结束未完成的一节；候选池没有可学内容时当场生成 */
  fresh?: boolean;
}

/** 联结练习的预估时长（秒） */
const CONNECTION_SECONDS = 90;
const LAST_REVISIT_KEY = 'last_topic_revisit';

/** 学习流程：学习主题、开始一节、作答、自评、申诉、结束、主题回访。 */
export function createLearning({ db, model, settings: currentSettings, illustrator }: LearningDeps) {
  /** 当前配置了画图模型时，讲解可以配插画 */
  const illustrationsOn = () => illustrator?.() !== undefined;

  // ---------- 学习主题 ----------

  function startTopic(title: string, now: Date) {
    const topicId = createTopic(db, title, now);
    enqueue(db, 'generate_graph', { topicId }, now);
    return { topicId };
  }

  function listTopics() {
    return db.select().from(topics).orderBy(asc(topics.createdAt)).all();
  }

  /** 暂停或恢复主题、调整优先级。暂停的主题不再新学，复习照常进行。 */
  function updateTopic(topicId: string, patch: { status?: 'active' | 'paused'; priority?: number }, now: Date) {
    const topic = getTopic(db, topicId);
    if (!topic) throw new LearningError('学习主题不存在', 404);
    db.update(topics).set(patch).where(eq(topics.id, topicId)).run();
    // 恢复的主题需要备新学内容
    if (patch.status === 'active' && topic.status === 'paused') enqueue(db, 'fill_pool', { now: now.toISOString() }, now, { dedupe: true });
    return getTopic(db, topicId)!;
  }

  // ---------- 开始一节 ----------

  /**
   * 开始下一节：有未结束的就继续它；否则从候选池按组装规则挑选。
   * 没有补充说明时只读候选池、不调用 AI，即时返回。
   * 有补充说明时，先按组装规则挑好这一节的内容，再按补充说明逐项重新生成（形式不变）；
   * 某项生成失败就沿用候选池里的原内容，不让这一节因此开不了。
   * 每个新知识点讲完后接一道联结练习（有可联结的对象时）。
   *
   * fresh（构建新一节）：不管有没有未完成的一节、候选池备没备好，都现在构建一节——
   * 未完成的那一节提前结束（没做的项不计入，之后重新安排）；候选池里没有可学的内容时当场生成。
   */
  async function nextSession(now: Date, options: NextSessionOptions = {}) {
    const empty = { session: null, preparing: false, resumed: false, guided: null, capped: false };
    const open = findOpenSession();
    if (open && !options.fresh) return { ...empty, session: viewSession(open.id), resumed: true };
    if (open) finishSession(open.id, now);

    const settings = currentSettings();
    const timeZone = options.timeZone ?? SERVER_TIME_ZONE;
    dayFormatter(timeZone);
    if (settings.dailySessionCap !== null && finishedToday(now, options.timeZone) >= settings.dailySessionCap) {
      return { ...empty, capped: true };
    }

    const mobile = options.device === 'mobile';
    let points = loadPoints(db);
    let states = loadStates(db);
    let picked = pickFromPool(now, points, states, mobile, settings).items;
    if (picked.length === 0 && options.fresh) {
      await fillPool({ db, model, settings: currentSettings, clock: () => now, illustrations: illustrationsOn() }, now);
      picked = pickFromPool(now, loadPoints(db), loadStates(db), mobile, settings).items;
    }
    if (picked.length === 0) return { ...empty, preparing: hasPendingWork() };

    let guided: { applied: number; total: number } | null = null;
    if (options.guidance) {
      const result = await regenerate(picked, options.guidance, now);
      picked = result.items;
      guided = { applied: result.applied, total: picked.length };
      // 生成要等一会儿；这期间如果已经开了别的一节（例如重复点击），以那一节为准
      const opened = findOpenSession();
      if (opened) return { ...empty, session: viewSession(opened.id), resumed: true };
    }

    if (currentSettings().reviewIntensity !== settings.reviewIntensity) {
      throw new LearningError('复习强度已更改，请重新开始下一节。', 409);
    }
    // 生成期间可能在地图里改了学习选择，按此刻的状态创建课堂
    points = loadPoints(db);
    states = loadStates(db);
    const stageOf = (id: string) => (states.get(id) ?? UNLEARNED).stage;
    const edgeIds = new Set(cognitiveEdge(points, states).map((p) => p.id));
    const excludedIds = new Set(points.filter((p) => p.excluded).map((p) => p.id));
    const includedIds = new Set(points.filter((p) => {
      if (p.excluded) return false;
      if (stageOf(p.id) === 'unlearned') return edgeIds.has(p.id);
      if (stageOf(p.id) === 'understand') return prerequisitesSatisfied(p, stageOf, excludedIds);
      return true;
    }).map((p) => p.id));
    picked = picked.filter((item) => includedIds.has(item.knowledgePointId));
    if (picked.length === 0) return { ...empty, preparing: hasPendingWork() };
    const byId = new Map(points.map((p) => [p.id, p]));
    const entries = withConnections(
      picked.map((item) => ({ itemId: item.id, purpose: purposeOf(item, states.get(item.knowledgePointId) ?? UNLEARNED) })),
      picked,
      byId,
      states,
      now,
    );
    const firstNew = entries.find((e) => e.purpose === 'new');
    const newTopicId = firstNew ? (byId.get(picked.find((i) => i.id === firstNew.itemId)!.knowledgePointId)?.topicId ?? null) : null;

    const sessionId = randomUUID();
    db.transaction((tx) => {
      tx.insert(sessions)
        .values({ id: sessionId, startedAt: now, budgetSeconds: settings.budgetSeconds, reviewIntensity: settings.reviewIntensity, timeZone, newTopicId, device: mobile ? 'mobile' : 'desktop', guidance: options.guidance ?? null })
        .run();
      entries.forEach((entry, position) => tx.insert(sessionItems).values({ sessionId, itemId: entry.itemId, position, purpose: entry.purpose }).run());
      markItemsUsed(tx, picked.map((i) => i.id));
    });
    return { ...empty, session: viewSession(sessionId), guided };
  }

  /**
   * 预览下一节：不开始、不改动任何数据，只说明此刻打开会学什么、大约多久。
   * 首页据此回答"下一节准备好了吗"。
   */
  function previewNext(now: Date, options: Pick<NextSessionOptions, 'device' | 'timeZone'> = {}) {
    const settings = currentSettings();
    const open = findOpenSession();
    const sessionsToday = finishedToday(now, options.timeZone);
    const capped = !open && settings.dailySessionCap !== null && sessionsToday >= settings.dailySessionCap;
    const points = loadPoints(db);
    const states = loadStates(db);
    const { items: picked, newPaused, timeFactor: factor } = pickFromPool(now, points, states, options.device === 'mobile', settings);
    const byId = new Map(points.map((p) => [p.id, p]));
    const purposes = picked.map((item) => purposeOf(item, states.get(item.knowledgePointId) ?? UNLEARNED));
    const count = (purpose: ItemPurpose) => purposes.filter((p) => p === purpose).length;
    const dueCount = points.filter((p) => !p.excluded && isDue(states.get(p.id) ?? UNLEARNED, now, settings.reviewIntensity)).length;
    const openView = open ? viewSession(open.id) : null;
    return {
      open: openView
        ? {
            id: openView.id,
            startedAt: openView.startedAt,
            items: openView.items.map((item) => ({
              title: item.title,
              topicTitle: item.topicTitle,
              purpose: item.purpose,
              formLabel: item.formLabel,
              excluded: item.excluded,
              done: item.excluded || (item.attempt !== null && !item.attempt.needsRating),
            })),
          }
        : null,
      capped,
      sessionsToday,
      dailySessionCap: settings.dailySessionCap,
      preparing: picked.length === 0 && hasPendingWork(),
      newPaused,
      dueCount,
      counts: { review: count('review'), contrast: count('contrast'), spotCheck: count('spot_check'), advance: count('advance'), new: count('new') },
      estMinutes: Math.max(1, Math.round(picked.reduce((sum, item) => sum + item.estSeconds * factor, 0) / 60)),
      budgetMinutes: Math.round(settings.budgetSeconds / 60),
      items: picked.map((item, i) => ({
        title: byId.get(item.knowledgePointId)?.title ?? '',
        topicTitle: byId.get(item.knowledgePointId)?.topicTitle ?? '',
        purpose: purposes[i]!,
        formLabel: formLabel(item.form),
      })),
    };
  }

  /**
   * 只更新本节未提交的内容，讲解正文和已作答记录保留。
   * 新题全部准备成功后，将课程与设置一起提交；生成失败或课堂已变化时不覆盖。
   */
  async function updateCurrentReviewIntensity(intensity: ReviewIntensity, now: Date, commitSettings: () => UserSettings): Promise<UserSettings> {
    const session = findOpenSession();
    if (!session || session.reviewIntensity === intensity) return commitSettings();
    const generationSettings = currentSettings();
    const points = loadPoints(db);
    const byId = new Map(points.map((point) => [point.id, point]));
    const states = loadStates(db);
    const entries = db.select().from(sessionItems).where(eq(sessionItems.sessionId, session.id)).orderBy(asc(sessionItems.position)).all();
    const rows = new Map(getItems(db, entries.map((entry) => entry.itemId)).map((row) => [row.id, row]));
    const pointIds = [...new Set([...rows.values()].map((row) => row.knowledgePointId))];
    const known = loadExistingKnowledge(db).map((knowledge) => knowledge.text);

    // 等待出题时允许继续使用应用，提交前核对课程、作答和学习选择是否发生变化。
    function snapshot() {
      return {
        session: db.select().from(sessions).where(eq(sessions.id, session!.id)).get(),
        entries: db.select().from(sessionItems).where(eq(sessionItems.sessionId, session!.id)).orderBy(asc(sessionItems.position)).all(),
        attempts: db.select().from(attempts).where(eq(attempts.sessionId, session!.id)).orderBy(asc(attempts.id)).all(),
        states: pointIds.length === 0 ? [] : db.select().from(memoryStates).where(inArray(memoryStates.knowledgePointId, pointIds)).orderBy(asc(memoryStates.knowledgePointId)).all(),
      };
    }
    const before = snapshot();
    const answered = new Set(before.attempts.map((attempt) => attempt.itemId));
    const removed: string[] = [];
    const replacements: { entry: typeof entries[number]; row: ItemRow; questionForm: QuestionForm }[] = [];
    let previousNewForm: string | null = null;
    for (const entry of entries) {
      const row = rows.get(entry.itemId)!;
      if (answered.has(row.id)) {
        if (entry.purpose === 'new') previousNewForm = row.questionForm;
        continue;
      }
      const point = byId.get(row.knowledgePointId);
      const state = states.get(row.knowledgePointId) ?? UNLEARNED;
      if (!point || point.excluded || reviewCompleted(state, intensity)) {
        removed.push(row.id);
        continue;
      }
      if (row.kind === 'connection') continue;
      const available = questionFormsFor(checkStageOf(state.stage), generationSettings.formPrefs, session.device === 'mobile', intensity);
      const avoid = entry.purpose === 'new' ? previousNewForm : state.lastQuestionForm;
      const questionForm = pickForm(available, avoid);
      if (entry.purpose === 'new') previousNewForm = questionForm;
      if (row.questionForm !== questionForm) replacements.push({ entry, row, questionForm });
    }

    const generated = await settleWithLimit(replacements.map(({ entry, row, questionForm }) => async () => {
      const lesson = row.kind === 'lesson' ? row.content as LessonContent : null;
      const guidance = [session.guidance, lesson ? `请围绕这份已有讲解编写配套小题：\n${lesson.explanation}` : null].filter(Boolean).join('\n\n');
      const context = contextOf(byId.get(row.knowledgePointId)!, byId, { guidance, state: states.get(row.knowledgePointId), existingKnowledge: known });
      const result = await generateReview(model, context, questionForm, { contentGuidance: generationSettings.contentGuidance });
      return {
        entry, row, questionForm,
        content: lesson ? { ...lesson, check: result.question } : { question: result.question },
        estSeconds: lesson ? row.estSeconds : result.estSeconds,
      };
    }), generationSettings.generationConcurrency);
    if (generated.some((result) => result.status === 'rejected')) {
      throw new LearningError('未能更新本次课程，请重试。原课程和设置已保留。', 502);
    }

    return db.transaction((tx) => {
      if (JSON.stringify(snapshot()) !== JSON.stringify(before) || JSON.stringify(currentSettings()) !== JSON.stringify(generationSettings)) {
        throw new LearningError('课程或设置已发生变化，请重新选择是否修改本次课程。', 409);
      }
      const saved = commitSettings();
      for (const result of generated) {
        if (result.status !== 'fulfilled') continue;
        const { entry, row, questionForm, content, estSeconds } = result.value;
        const itemId = insertItem(tx, {
          knowledgePointId: row.knowledgePointId, kind: row.kind,
          form: row.kind === 'lesson' ? row.form : questionForm,
          questionForm, content, estSeconds, status: 'used',
        }, now);
        tx.delete(sessionItems).where(and(eq(sessionItems.sessionId, session.id), eq(sessionItems.itemId, row.id))).run();
        tx.insert(sessionItems).values({ ...entry, itemId }).run();
        // 讲解没有改写，原插画跟随新小题继续使用，包括尚未完成或可重试的插画。
        if (row.kind === 'lesson') tx.update(illustrations).set({ itemId }).where(eq(illustrations.itemId, row.id)).run();
        tx.update(items).set({ status: 'void' }).where(eq(items.id, row.id)).run();
      }
      if (removed.length > 0) {
        tx.delete(sessionItems).where(and(eq(sessionItems.sessionId, session.id), inArray(sessionItems.itemId, removed))).run();
        tx.update(items).set({ status: 'void' }).where(inArray(items.id, removed)).run();
      }
      tx.update(sessions).set({ reviewIntensity: intensity }).where(eq(sessions.id, session.id)).run();
      return saved;
    });
  }

  // ---------- 作答 ----------

  /**
   * 提交作答：选择题、点选错误行按规则判分，简答、补全、修正和联结练习由 AI 批改。
   * 答错时立即更新记忆状态；答对时等自评。联结练习不计入记忆状态。
   */
  async function submitAttempt(input: { sessionId: string; itemId: string; answer: Answer; durationMs?: number }, now: Date) {
    const item = requireSessionItem(input.sessionId, input.itemId);
    const reviewIntensity = db.select().from(sessions).where(eq(sessions.id, input.sessionId)).get()!.reviewIntensity;
    const exists = db
      .select({ id: attempts.id })
      .from(attempts)
      .where(and(eq(attempts.sessionId, input.sessionId), eq(attempts.itemId, input.itemId)))
      .get();
    if (exists) throw new LearningError('这一项已经作答过了', 409);

    if (item.kind === 'connection') return submitConnection(item, input, now);

    const question = questionOf(item)!;
    const grade = await gradeAnswer(item, question, input.answer);
    // AI 批改期间可能改为不学或结束课堂，保存作答前再次确认
    requireSessionItem(input.sessionId, input.itemId);
    const attemptId = randomUUID();
    db.insert(attempts)
      .values({
        id: attemptId,
        itemId: item.id,
        sessionId: input.sessionId,
        answer: input.answer,
        correct: grade.correct,
        reviewIntensity,
        errorType: grade.errorType,
        feedback: grade.feedback,
        durationMs: input.durationMs,
        createdAt: now,
      })
      .run();
    if (!grade.correct) {
      const misconception = question.type === 'mcq' && 'choice' in input.answer ? misconceptionOf(question, input.answer.choice) : grade.errorType === 'misconception' ? grade.feedback : null;
      applyOutcome(attemptId, item, { correct: false, errorType: grade.errorType ?? undefined, misconception }, now);
    }
    return { attemptId, ...grade, needsRating: grade.correct, reveal: reveal(question) };
  }

  /** 联结练习：认可时在认知地图上加一条带原话的联结；不认可时不入图，对方知识点立即到期复习 */
  async function submitConnection(item: ItemRow, input: { sessionId: string; answer: Answer; durationMs?: number }, now: Date) {
    if (!('text' in input.answer)) throw new LearningError('联结练习需要提交文字作答', 400);
    const content = item.content as ConnectionContent;
    const points = loadPoints(db);
    const point = points.find((p) => p.id === item.knowledgePointId);
    const verdict = await gradeConnection(
      model,
      { topicTitle: point?.topicTitle ?? '', title: point?.title ?? '', summary: point?.summary ?? '', partner: content.partner.title },
      content.prompt,
      input.answer.text,
    );
    requireSessionItem(input.sessionId, item.id);
    const attemptId = randomUUID();
    db.transaction((tx) => {
      tx.insert(attempts)
        .values({
          id: attemptId,
          itemId: item.id,
          sessionId: input.sessionId,
          answer: input.answer,
          correct: verdict.accepted,
          feedback: verdict.feedback,
          applied: true,
          durationMs: input.durationMs,
          createdAt: now,
        })
        .run();
      if (verdict.accepted) {
        tx.insert(connections)
          .values({
            id: randomUUID(),
            fromPointId: item.knowledgePointId,
            toPointId: content.partner.kind === 'point' ? content.partner.id : null,
            toExistingId: content.partner.kind === 'existing' ? content.partner.id : null,
            quote: (input.answer as { text: string }).text,
            relation: verdict.relation,
            attemptId,
            createdAt: now,
          })
          .run();
      }
    });
    if (!verdict.accepted && content.partner.kind === 'point') duePartnerNow(content.partner.id, now);
    return {
      attemptId,
      correct: verdict.accepted,
      errorType: null,
      feedback: verdict.feedback,
      needsRating: false,
      reveal: { relation: verdict.relation },
    };
  }

  /** 答对后的自评 */
  function rateAttempt(attemptId: string, selfRating: SelfRating, now: Date) {
    const attempt = db.select().from(attempts).where(eq(attempts.id, attemptId)).get();
    if (!attempt) throw new LearningError('作答记录不存在', 404);
    if (!attempt.correct) throw new LearningError('答错时不需要自评', 400);
    if (attempt.applied) throw new LearningError('这次作答已经自评过了', 409);
    const [item] = getItems(db, [attempt.itemId]);
    applyOutcome(attemptId, item!, { correct: true, selfRating }, now);
    return { ok: true };
  }

  /**
   * 申诉：对判错的作答发起，由 AI 重新判定。
   * - 答案也成立：还原作答前的记忆状态，改判为答对，等用户补一次自评；
   * - 题目或参考答案有误：还原作答前的记忆状态，这次作答作废，不计入记忆状态；
   * - 维持原判：不变。
   * 只能对这个知识点最近一次计入记忆的作答申诉，否则还原会覆盖之后的进展。
   */
  async function appealAttempt(attemptId: string, reason: string, now: Date) {
    const attempt = db.select().from(attempts).where(eq(attempts.id, attemptId)).get();
    if (!attempt) throw new LearningError('作答记录不存在', 404);
    const [item] = getItems(db, [attempt.itemId]);
    if (!item || item.kind === 'connection') throw new LearningError('联结练习不能申诉', 400);
    if (attempt.correct) throw new LearningError('只能对判错的作答申诉', 400);
    if (attempt.appeal) throw new LearningError('这次作答已经申诉过了', 409);
    if (hasLaterApplied(attempt, item.knowledgePointId)) {
      throw new LearningError('这个知识点之后又有了新的作答，不能再对这一次申诉', 409);
    }

    const point = loadPoints(db).find((p) => p.id === item.knowledgePointId);
    const answer = attempt.answer as Answer;
    const verdict = await judgeAppeal(model, { topicTitle: point?.topicTitle ?? '', title: point?.title ?? '' }, {
      question: questionOf(item)!,
      answer: 'text' in answer ? answer.text : `选择了第 ${answer.choice + 1} 项`,
      originalFeedback: attempt.feedback ?? '',
      reason,
    });
    const appeal: Appeal = { reason, outcome: verdict.outcome, feedback: verdict.feedback, at: now.toISOString() };
    const before = stateFromJson(attempt.stateBefore);

    db.transaction((tx) => {
      if (verdict.outcome !== 'rejected' && before) saveState(tx, item.knowledgePointId, before, now);
      if (verdict.outcome === 'accepted') {
        tx.update(attempts).set({ appeal, correct: true, errorType: null, applied: false }).where(eq(attempts.id, attemptId)).run();
      } else if (verdict.outcome === 'void') {
        tx.update(attempts).set({ appeal, voided: true }).where(eq(attempts.id, attemptId)).run();
        tx.update(items).set({ status: 'void' }).where(eq(items.id, item.id)).run();
      } else {
        tx.update(attempts).set({ appeal }).where(eq(attempts.id, attemptId)).run();
      }
    });
    if (verdict.outcome !== 'rejected') enqueue(db, 'fill_pool', { now: now.toISOString() }, now, { dedupe: true });
    return { outcome: verdict.outcome, feedback: verdict.feedback, needsRating: verdict.outcome === 'accepted' };
  }

  // ---------- 结束一节 ----------

  /** 结束一节：答对但没自评的按"良好"处理，然后在后台补满候选池；到了主题回访的时候带上回访题。 */
  function finishSession(sessionId: string, now: Date) {
    const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!session) throw new LearningError('这一节不存在', 404);
    if (!session.finishedAt) {
      const unrated = db
        .select()
        .from(attempts)
        .where(and(eq(attempts.sessionId, sessionId), eq(attempts.applied, false)))
        .all();
      for (const attempt of unrated) {
        const [item] = getItems(db, [attempt.itemId]);
        applyOutcome(attempt.id, item!, { correct: true, selfRating: 'good' }, now);
      }
      db.update(sessions).set({ finishedAt: now }).where(eq(sessions.id, sessionId)).run();
      enqueue(db, 'fill_pool', { now: now.toISOString() }, now, { dedupe: true });
    }
    return { ok: true, revisit: revisitQuestion(now) };
  }

  /** 主题回访题：问用户暂停的主题里哪些想恢复学习 */
  function revisitQuestion(now: Date) {
    const paused = db.select({ id: topics.id, title: topics.title }).from(topics).where(eq(topics.status, 'paused')).all();
    const last = readState<string>(db, LAST_REVISIT_KEY);
    const due = revisitDue(last ? new Date(last) : null, now, currentSettings().revisitIntervalDays, paused.length);
    return due ? { topics: paused } : null;
  }

  /** 回答主题回访：选中的主题恢复新学；"暂时都不"时传空数组。不计入记忆评分。 */
  function answerRevisit(resumeTopicIds: string[], now: Date) {
    db.transaction((tx) => {
      if (resumeTopicIds.length > 0) {
        tx.update(topics).set({ status: 'active' }).where(and(inArray(topics.id, resumeTopicIds), eq(topics.status, 'paused'))).run();
      }
      writeState(tx, LAST_REVISIT_KEY, now.toISOString(), now);
    });
    if (resumeTopicIds.length > 0) enqueue(db, 'fill_pool', { now: now.toISOString() }, now, { dedupe: true });
    return { ok: true };
  }

  // ---------- 内部 ----------

  function findOpenSession() {
    return db.select().from(sessions).where(isNull(sessions.finishedAt)).orderBy(asc(sessions.startedAt)).get();
  }

  /** 今天（用户时区）已经完成了几节 */
  function finishedToday(now: Date, timeZone = SERVER_TIME_ZONE): number {
    const dayOf = dayFormatter(timeZone);
    const today = dayOf(now);
    return db
      .select({ finishedAt: sessions.finishedAt })
      .from(sessions)
      .where(isNotNull(sessions.finishedAt))
      .all()
      .filter((s) => dayOf(s.finishedAt!) === today).length;
  }

  /** 按组装规则从候选池挑出一节（不写入数据库） */
  function pickFromPool(now: Date, points: PointInfo[], states: Map<string, MemoryState>, mobile: boolean, settings: Settings) {
    const pool = loadPool(db);
    const factor = currentTimeFactor();
    const result = assemble({
      points,
      states,
      pool,
      now,
      budgetSeconds: settings.budgetSeconds,
      maxNewPerSession: settings.maxNewPerSession,
      newTopicId: chooseTopicForNew(points, states, pool, mobile),
      mobile,
      timeFactor: factor,
      reviewIntensity: settings.reviewIntensity,
    });
    return { ...result, timeFactor: factor };
  }

  /** 这一节的新知识点来自哪个主题：在候选池里备有新学内容的主题之间，按优先级轮换 */
  function chooseTopicForNew(points: PointInfo[], states: Map<string, MemoryState>, pool: PoolItem[], mobile: boolean): string | null {
    const ready = new Set(
      pool.filter((i) => i.kind === 'lesson' && (!mobile || isMobileForm(i.questionForm))).map((i) => i.knowledgePointId),
    );
    const topicIds = new Set(cognitiveEdge(points, states).filter((p) => ready.has(p.id)).map((p) => p.topicId!));
    if (topicIds.size === 0) return null;
    const served = db.select({ newTopicId: sessions.newTopicId }).from(sessions).where(isNotNull(sessions.newTopicId)).all();
    const rows = db.select().from(topics).where(inArray(topics.id, [...topicIds])).all();
    return chooseNewTopic(
      rows.map((t) => ({
        topicId: t.id,
        priority: t.priority,
        servedSessions: served.filter((s) => s.newTopicId === t.id).length,
        createdAt: t.createdAt.getTime(),
      })),
    );
  }

  /** 时长校准系数：按最近的作答用时 */
  function currentTimeFactor(): number {
    const samples = db
      .select({ estSeconds: items.estSeconds, durationMs: attempts.durationMs })
      .from(attempts)
      .innerJoin(items, eq(attempts.itemId, items.id))
      .where(and(isNotNull(attempts.durationMs), ne(items.kind, 'connection')))
      .orderBy(desc(attempts.createdAt))
      .limit(20)
      .all()
      .reverse();
    return timeFactor(samples.map((s) => ({ estSeconds: s.estSeconds, durationMs: s.durationMs! })));
  }

  /** 每个新知识点之后插入一道联结练习：与已学会的前置、易混知识点，或用户的已有知识建立联系 */
  function withConnections(
    entries: { itemId: string; purpose: ItemPurpose }[],
    picked: PoolItem[],
    byId: Map<string, PointInfo>,
    states: Map<string, MemoryState>,
    now: Date,
  ) {
    const known = loadExistingKnowledge(db);
    const result: { itemId: string; purpose: ItemPurpose }[] = [];
    entries.forEach((entry, i) => {
      result.push(entry);
      if (entry.purpose !== 'new') return;
      const point = byId.get(picked[i]!.knowledgePointId);
      if (!point) return;
      const partner = choosePartner(point, byId, states, known);
      if (!partner) return;
      const content: ConnectionContent = { prompt: connectionPrompt(point.title, partner), partner };
      const itemId = insertItem(
        db,
        { knowledgePointId: point.id, kind: 'connection', form: 'connection', questionForm: 'connection', estSeconds: CONNECTION_SECONDS, content, status: 'used' },
        now,
      );
      result.push({ itemId, purpose: 'connection' });
    });
    return result;
  }

  /** 按补充说明重新生成挑好的内容：成功的存入并替换原内容，失败的沿用原内容 */
  async function regenerate(picked: PoolItem[], guidance: string, now: Date) {
    const generationSettings = currentSettings();
    const points = loadPoints(db);
    const states = loadStates(db);
    const known = loadExistingKnowledge(db).map((k) => k.text);
    const byId = new Map(points.map((p) => [p.id, p]));
    const results = await settleWithLimit(
      picked.map((item) => () =>
        generateItem(
          model,
          contextOf(byId.get(item.knowledgePointId)!, byId, { guidance, state: states.get(item.knowledgePointId), existingKnowledge: known }),
          needOf(item),
          { illustrations: illustrationsOn(), contentGuidance: generationSettings.contentGuidance },
        ),
      ),
      generationSettings.generationConcurrency,
    );
    if (!sameContentGuidance(generationSettings.contentGuidance, currentSettings().contentGuidance)) {
      throw new LearningError('生成期间引导词已更新，请重新开始，新内容将按最新要求准备。', 409);
    }
    const replaced = picked.map((item, i): PoolItem => {
      const result = results[i]!;
      if (result.status === 'rejected') {
        console.warn(`按补充说明生成失败，沿用原内容（${item.kind} / ${item.knowledgePointId}）：${String(result.reason)}`);
        return item;
      }
      const id = db.transaction((tx) => {
        tx.update(items).set({ status: 'void' }).where(eq(items.id, item.id)).run();
        return saveGeneratedItem(tx, result.value, now);
      });
      return { ...item, id, estSeconds: result.value.estSeconds };
    });
    return { items: replaced, applied: results.filter((r) => r.status === 'fulfilled').length };
  }

  /**
   * 按作答结果更新记忆状态，并记下更新前的状态（申诉改判时还原）。
   * 讲解类内容对已学过的知识点是对比讲解，按复习结果更新。
   * 理解或回忆阶段连续答错达到阈值时，后台拆解出更基础的前置知识点。
   */
  function applyOutcome(attemptId: string, item: ItemRow, outcome: Outcome, now: Date) {
    const state = loadStates(db).get(item.knowledgePointId) ?? UNLEARNED;
    const attempt = db.select().from(attempts).where(eq(attempts.id, attemptId)).get()!;
    const session = db.select().from(sessions).where(eq(sessions.id, attempt.sessionId)).get()!;
    const reviewContext = { intensity: attempt.reviewIntensity, timeZone: session.timeZone ?? 'UTC', answeredAt: attempt.createdAt };
    const question = questionOf(item)!;
    let next: MemoryState;
    if (item.kind === 'lesson' && !hasSchedule(state.stage) && state.stage !== 'inferred') {
      next = applyLessonOutcome(state, { explainForm: item.form, questionForm: question.type }, outcome, now, reviewContext);
    } else if (hasSchedule(state.stage) || state.stage === 'inferred') {
      next = { ...applyReviewOutcome(state, question.type, outcome, now, reviewContext), lastExplainForm: item.kind === 'lesson' ? item.form : state.lastExplainForm };
    } else {
      // 知识点已被重新学习等操作改变了阶段，这次作答不再计入
      next = state;
    }
    db.transaction((tx) => {
      saveState(tx, item.knowledgePointId, next, now);
      tx.update(attempts)
        .set({ applied: true, selfRating: outcome.correct ? outcome.selfRating : null, stateBefore: state })
        .where(eq(attempts.id, attemptId))
        .run();
    });
    if (needsDecomposition(next) && next.failStreak === DECOMPOSE_FAIL_STREAK && !wasDecomposed(db, item.knowledgePointId)) {
      enqueue(db, 'decompose', { knowledgePointId: item.knowledgePointId }, now);
    }
  }

  async function gradeAnswer(item: ItemRow, question: Question, answer: Answer): Promise<Grade> {
    if (question.type === 'mcq' || question.type === 'pick_line') {
      if (!('choice' in answer)) throw new LearningError('这道题需要提交选项序号', 400);
      return question.type === 'mcq' ? gradeMcq(question, answer.choice) : gradePickLine(question, answer.choice);
    }
    if (!('text' in answer)) throw new LearningError('这道题需要提交文字作答', 400);
    if (!isOpenQuestion(question)) throw new LearningError('不支持的题目形式', 400);
    const point = loadPoints(db).find((p) => p.id === item.knowledgePointId);
    return gradeOpenAnswer(model, { topicTitle: point?.topicTitle ?? '', title: point?.title ?? '' }, question, answer.text);
  }

  /** 联结不成立：对方知识点立即到期，下一节复习它 */
  function duePartnerNow(pointId: string, now: Date) {
    if (db.select().from(memoryStates).where(eq(memoryStates.knowledgePointId, pointId)).get()?.excluded) return;
    const state = loadStates(db).get(pointId);
    if (!state?.card || !hasSchedule(state.stage)) return;
    saveState(db, pointId, { ...state, reviewProgress: UNCONFIRMED_REVIEW_PROGRESS, card: { ...state.card, due: now } }, now);
  }

  /** 之后是否又有有效作答；相同时间按入库顺序判断，作废记录不阻止申诉。 */
  function hasLaterApplied(attempt: typeof attempts.$inferSelect, knowledgePointId: string): boolean {
    const later = db
      .select({ id: attempts.id })
      .from(attempts)
      .innerJoin(items, eq(attempts.itemId, items.id))
      .where(and(
        eq(items.knowledgePointId, knowledgePointId),
        eq(attempts.applied, true),
        eq(attempts.voided, false),
        ne(items.kind, 'connection'),
        or(
          gt(attempts.createdAt, attempt.createdAt),
          and(eq(attempts.createdAt, attempt.createdAt), sql`attempts.rowid > (select rowid from attempts where id = ${attempt.id})`),
        ),
      ))
      .get();
    return later !== undefined;
  }

  function requireSessionItem(sessionId: string, itemId: string): ItemRow {
    const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!session) throw new LearningError('这一节不存在', 404);
    if (session.finishedAt) throw new LearningError('这一节已经结束', 409);
    const link = db
      .select()
      .from(sessionItems)
      .where(and(eq(sessionItems.sessionId, sessionId), eq(sessionItems.itemId, itemId)))
      .get();
    if (!link) throw new LearningError('这一项不属于本节', 404);
    const item = getItems(db, [itemId])[0]!;
    const state = db.select().from(memoryStates).where(eq(memoryStates.knowledgePointId, item.knowledgePointId)).get();
    if (state?.excluded) throw new LearningError('这个知识点已设为不学，重新加入学习后才能作答', 409);
    return item;
  }

  function hasPendingWork(): boolean {
    return db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.status, ['pending', 'running'])).get() !== undefined;
  }

  /** 给前端看的一节内容：作答前不包含答案。 */
  function viewSession(sessionId: string) {
    const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()!;
    const links = db.select().from(sessionItems).where(eq(sessionItems.sessionId, sessionId)).orderBy(asc(sessionItems.position)).all();
    const rows = new Map(getItems(db, links.map((l) => l.itemId)).map((r) => [r.id, r]));
    const done = db.select().from(attempts).where(eq(attempts.sessionId, sessionId)).all();
    const points = new Map(loadPoints(db).map((p) => [p.id, p]));
    return {
      id: sessionId,
      startedAt: session.startedAt,
      budgetSeconds: session.budgetSeconds,
      reviewIntensity: session.reviewIntensity,
      guidance: session.guidance,
      items: links.map((link) => {
        const row = rows.get(link.itemId)!;
        const attempt = done.find((a) => a.itemId === row.id);
        const question = questionOf(row);
        const point = points.get(row.knowledgePointId);
        return {
          id: row.id,
          kind: row.kind,
          purpose: link.purpose,
          form: row.form,
          formLabel: formLabel(row.form),
          knowledgePointId: row.knowledgePointId,
          excluded: point?.excluded ?? false,
          title: point?.title ?? '',
          topicTitle: point?.topicTitle ?? '',
          estSeconds: row.estSeconds,
          ...itemBody(row),
          attempt: attempt
            ? {
                attemptId: attempt.id,
                correct: attempt.correct,
                errorType: attempt.errorType,
                feedback: attempt.feedback,
                needsRating: attempt.correct && !attempt.applied,
                reveal: question ? reveal(question) : null,
                appeal: (attempt.appeal as Appeal | null) ?? null,
                voided: attempt.voided,
              }
            : null,
        };
      }),
    };
  }

  return {
    startTopic,
    listTopics,
    updateTopic,
    nextSession,
    previewNext,
    updateCurrentReviewIntensity,
    submitAttempt,
    rateAttempt,
    appealAttempt,
    finishSession,
    answerRevisit,
  };
}

export type Learning = ReturnType<typeof createLearning>;

/** 组装时确定这一项的用途 */
function purposeOf(item: PoolItem, state: MemoryState): ItemPurpose {
  if (item.form === CONTRAST_FORM) return 'contrast';
  if (item.kind === 'review') return state.stage === 'inferred' ? 'spot_check' : 'review';
  return state.stage === 'unlearned' ? 'new' : 'advance';
}

/**
 * 联结练习的对象：已学会的前置知识点优先，其次已学会的易混知识点，再次用户的已有知识（同主题的优先）。
 * 都没有时不出联结练习。
 */
function choosePartner(
  point: PointInfo,
  byId: Map<string, PointInfo>,
  states: Map<string, MemoryState>,
  known: { id: string; text: string; topicId: string | null }[],
): ConnectionContent['partner'] | null {
  const learned = (id: string) => !byId.get(id)?.excluded && hasLearned((states.get(id) ?? UNLEARNED).stage);
  const byPosition = (ids: string[]) => ids.filter(learned).sort((a, b) => (byId.get(a)?.position ?? 0) - (byId.get(b)?.position ?? 0));
  const pointId = byPosition(point.prerequisiteIds).at(-1) ?? byPosition(point.confusableIds)[0];
  if (pointId) return { kind: 'point', id: pointId, title: byId.get(pointId)!.title };
  const existing = known.find((k) => k.topicId === point.topicId) ?? known[0];
  return existing ? { kind: 'existing', id: existing.id, title: existing.text } : null;
}

function connectionPrompt(title: string, partner: ConnectionContent['partner']): string {
  return partner.kind === 'point'
    ? `用你自己的话说说「${title}」和「${partner.title}」是什么关系：比如谁是谁的前提、有什么相同和不同、什么时候用哪个。一两句话就够。`
    : `用你自己的话说说「${title}」和你已经会的「${partner.title}」有什么联系：它们哪里相像、哪里不同，或者已经会的怎样帮你理解新的。一两句话就够。`;
}

/** 候选池中一项内容的形式，换算成重新生成时需要的形式 */
function needOf(item: PoolItem): PoolNeed {
  // 形式都是本系统生成内容时写入的，取值必在 EXPLAIN_FORMS / QUESTION_FORMS 中
  return item.kind === 'lesson'
    ? { kind: 'lesson', knowledgePointId: item.knowledgePointId, explainForm: item.form as ExplainForm, questionForm: item.questionForm as QuestionForm }
    : { kind: 'review', knowledgePointId: item.knowledgePointId, questionForm: item.form as QuestionForm };
}
