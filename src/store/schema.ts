import { blob, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { TopicBrief, TopicMessage } from '../shared/topic-planning';
import type { ReviewProgress } from '../domain/review';

// 时间统一存毫秒时间戳
const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' });

/** 学习主题 */
export const topics = sqliteTable('topics', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  learningBrief: text('learning_brief', { mode: 'json' }).$type<TopicBrief>(),
  // 暂停的主题不再新学，复习照常进行
  status: text('status', { enum: ['active', 'paused'] }).notNull().default('active'),
  // 新学按优先级轮换：1 低、2 中、3 高
  priority: integer('priority').notNull().default(1),
  graphStatus: text('graph_status', { enum: ['pending', 'ready', 'failed'] }).notNull().default('pending'),
  // 摸底诊断：没做完之前这个主题不新学；跳过则所有知识点从未学开始
  placementStatus: text('placement_status', { enum: ['pending', 'preparing', 'testing', 'done', 'skipped'] })
    .notNull()
    .default('pending'),
  createdAt: timestamp('created_at').notNull(),
});

/** 尚在澄清的主题；只有明确确认后才关联正式学习主题。 */
export const topicDrafts = sqliteTable('topic_drafts', {
  id: text('id').primaryKey(),
  idea: text('idea').notNull(),
  messages: text('messages', { mode: 'json' }).$type<TopicMessage[]>().notNull(),
  brief: text('brief', { mode: 'json' }).$type<TopicBrief>(),
  revision: integer('revision').notNull().default(0),
  topicId: text('topic_id').references(() => topics.id),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

/** 知识点：系统中只存一份 */
export const knowledgePoints = sqliteTable('knowledge_points', {
  id: text('id').primaryKey(),
  topicId: text('topic_id').notNull().references(() => topics.id),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  // AI 给出的推荐顺序，认知顺序相同时用它排先后
  position: integer('position').notNull(),
  // graph：骨架图谱生成的；decomposed：某个知识点反复失败时拆解出的更基础的前置知识点；
  // asked：从学习时的提问里整理出、用户确认加入的知识点
  origin: text('origin', { enum: ['graph', 'decomposed', 'asked'] }).notNull().default('graph'),
});

/**
 * 知识图谱中的关系。
 * prerequisite：from 是 to 的前置；composition：from 是 to 的一部分；confusable：二者易混，无方向。
 */
export const relations = sqliteTable('relations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fromId: text('from_id').notNull().references(() => knowledgePoints.id),
  toId: text('to_id').notNull().references(() => knowledgePoints.id),
  type: text('type', { enum: ['composition', 'prerequisite', 'confusable'] }).notNull(),
});

/** 记忆状态：按知识点只记一份 */
export const memoryStates = sqliteTable('memory_states', {
  knowledgePointId: text('knowledge_point_id').primaryKey().references(() => knowledgePoints.id),
  // 学习选择与掌握阶段分开保存；不学时保留记忆参数和作答记录
  excluded: integer('excluded', { mode: 'boolean' }).notNull().default(false),
  stage: text('stage', { enum: ['unlearned', 'inferred', 'understand', 'recall', 'apply', 'retain'] }).notNull(),
  // FSRS 卡片，进入回忆阶段后才有
  card: text('card', { mode: 'json' }),
  lastExplainForm: text('last_explain_form'),
  lastQuestionForm: text('last_question_form'),
  // 理解、回忆阶段连续答错的次数
  failStreak: integer('fail_streak').notNull().default(0),
  // 上次答错属于误解，下一次改用对比讲解
  pendingContrast: integer('pending_contrast', { mode: 'boolean' }).notNull().default(false),
  lastMisconception: text('last_misconception'),
  // null 表示旧记录，读取时根据本轮有效作答还原证据
  reviewProgress: text('review_progress', { mode: 'json' }).$type<ReviewProgress>(),
  // 已拆解过，不再重复拆解
  decomposedAt: timestamp('decomposed_at'),
  updatedAt: timestamp('updated_at').notNull(),
});

/** 候选池中的一项内容 */
export const items = sqliteTable('items', {
  id: text('id').primaryKey(),
  knowledgePointId: text('knowledge_point_id').notNull().references(() => knowledgePoints.id),
  // lesson：讲解 + 当场小题；review：复习题；connection：联结练习（开始一节时按模板生成）
  kind: text('kind', { enum: ['lesson', 'review', 'connection'] }).notNull(),
  // lesson 为讲解形式，review 为题目形式，connection 为 connection
  form: text('form').notNull(),
  // 题目形式：lesson 是当场小题的形式，review 与 form 相同
  questionForm: text('question_form').notNull(),
  content: text('content', { mode: 'json' }).notNull(),
  estSeconds: integer('est_seconds').notNull(),
  status: text('status', { enum: ['pooled', 'used', 'void'] }).notNull().default('pooled'),
  createdAt: timestamp('created_at').notNull(),
});

/** 讲解里的插画：由图像模型在后台画好，讲解正文用 ![说明](illustration:<id>) 引用 */
export const illustrations = sqliteTable('illustrations', {
  id: text('id').primaryKey(),
  itemId: text('item_id').notNull().references(() => items.id),
  // 交给图像模型的完整提示词，单独保存，便于查看和重画
  prompt: text('prompt').notNull(),
  status: text('status', { enum: ['pending', 'ready', 'failed'] }).notNull().default('pending'),
  image: blob('image', { mode: 'buffer' }),
  mediaType: text('media_type'),
  createdAt: timestamp('created_at').notNull(),
});

/** 一节微课堂 */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  startedAt: timestamp('started_at').notNull(),
  finishedAt: timestamp('finished_at'),
  budgetSeconds: integer('budget_seconds').notNull(),
  // 本节固定使用开始时的强度和时区，设置变化从下一节生效
  reviewIntensity: text('review_intensity', { enum: ['low', 'high'] }).notNull().default('high'),
  timeZone: text('time_zone'),
  // 这一节的新知识点来自哪个主题，用于新学按主题轮换
  newTopicId: text('new_topic_id'),
  device: text('device', { enum: ['desktop', 'mobile'] }).notNull().default('desktop'),
  // 开始时写的补充说明
  guidance: text('guidance'),
});

/** 一节微课堂包含的内容与顺序 */
export const sessionItems = sqliteTable(
  'session_items',
  {
    sessionId: text('session_id').notNull().references(() => sessions.id),
    itemId: text('item_id').notNull().references(() => items.id),
    position: integer('position').notNull(),
    // 这一项在本节中的用途，组装时确定：新学、重讲、对比讲解、复习、抽查、联结练习
    purpose: text('purpose', { enum: ['new', 'advance', 'contrast', 'review', 'spot_check', 'connection'] }).notNull().default('new'),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.itemId] })],
);

/** 作答记录 */
export const attempts = sqliteTable('attempts', {
  id: text('id').primaryKey(),
  itemId: text('item_id').notNull().references(() => items.id),
  sessionId: text('session_id').notNull().references(() => sessions.id),
  answer: text('answer', { mode: 'json' }).notNull(),
  correct: integer('correct', { mode: 'boolean' }).notNull(),
  errorType: text('error_type', { enum: ['misconception', 'forgetting'] }),
  feedback: text('feedback'),
  selfRating: text('self_rating', { enum: ['hard', 'good', 'easy'] }),
  // 当前课堂可以换档，已提交的作答仍按提交时的规则更新记忆
  reviewIntensity: text('review_intensity', { enum: ['low', 'high'] }).notNull().default('high'),
  // 记忆状态是否已按本次作答更新（答对时要等自评后才更新）
  applied: integer('applied', { mode: 'boolean' }).notNull().default(false),
  // 按本次作答更新之前的记忆状态，申诉改判时据此还原
  stateBefore: text('state_before', { mode: 'json' }),
  // 申诉：理由、结论、反馈
  appeal: text('appeal', { mode: 'json' }),
  // 申诉判定题目有误：作废，不计入记忆状态
  voided: integer('voided', { mode: 'boolean' }).notNull().default(false),
  durationMs: integer('duration_ms'),
  createdAt: timestamp('created_at').notNull(),
});

/** 后台任务：持久保存，服务重启后接着执行 */
export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type', { enum: ['generate_graph', 'fill_pool', 'prepare_placement', 'decompose', 'generate_cheatsheet', 'generate_illustration'] }).notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
  status: text('status', { enum: ['pending', 'running', 'done', 'failed'] }).notNull().default('pending'),
  tries: integer('tries').notNull().default(0),
  lastError: text('last_error'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

/** 用户设置与少量应用状态，按键存 JSON */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

/** 已有知识：学习之前就具备、可作为新知识挂靠点的知识，可以不属于任何学习主题 */
export const existingKnowledge = sqliteTable('existing_knowledge', {
  id: text('id').primaryKey(),
  // 从哪个主题的摸底自述里提炼出来的；用户手动添加时为空
  topicId: text('topic_id'),
  text: text('text').notNull(),
  createdAt: timestamp('created_at').notNull(),
});

/** 联结：用户在练习中用自己的话说明两个知识的关系，经 AI 认可后形成 */
export const connections = sqliteTable('connections', {
  id: text('id').primaryKey(),
  fromPointId: text('from_point_id').notNull().references(() => knowledgePoints.id),
  // 另一端是知识点或已有知识，二选一
  toPointId: text('to_point_id').references(() => knowledgePoints.id),
  toExistingId: text('to_existing_id').references(() => existingKnowledge.id),
  // 用户原话
  quote: text('quote').notNull(),
  // AI 对关系的一句话概括
  relation: text('relation').notNull(),
  attemptId: text('attempt_id').notNull().references(() => attempts.id),
  createdAt: timestamp('created_at').notNull(),
});

/** 摸底诊断：每个主题一份 */
export const placements = sqliteTable('placements', {
  topicId: text('topic_id').primaryKey().references(() => topics.id),
  background: text('background').notNull(),
  // 背景自述推断的起点（知识点 id）
  startIds: text('start_ids', { mode: 'json' }).notNull(),
  // 预先生成的候选题：[{ pointId, question }]
  probes: text('probes', { mode: 'json' }).notNull(),
  // 作答：[{ pointId, choice, result }]
  answers: text('answers', { mode: 'json' }).notNull(),
  createdAt: timestamp('created_at').notNull(),
  finishedAt: timestamp('finished_at'),
});

/** 速查表 */
export const cheatsheets = sqliteTable('cheatsheets', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  // 选定的范围：{ topicIds, stages }
  scope: text('scope', { mode: 'json' }).notNull(),
  status: text('status', { enum: ['pending', 'ready', 'failed'] }).notNull().default('pending'),
  markdown: text('markdown'),
  createdAt: timestamp('created_at').notNull(),
});

/** 提问的会话：一段连续的问答；新建会话后不再带上之前的上下文 */
export const askThreads = sqliteTable('ask_threads', {
  id: text('id').primaryKey(),
  // 在哪一节里问的（学习页），或在看哪个知识点时问的（认知地图、回看页）
  sessionId: text('session_id').references(() => sessions.id),
  knowledgePointId: text('knowledge_point_id').references(() => knowledgePoints.id),
  createdAt: timestamp('created_at').notNull(),
});

/** 学习时的提问：随时问、随时答，可从中整理出不了解的知识加入认知地图 */
export const asks = sqliteTable('asks', {
  id: text('id').primaryKey(),
  threadId: text('thread_id').notNull().references(() => askThreads.id),
  sessionId: text('session_id').references(() => sessions.id),
  // 提问时正在学或正在看的知识点
  knowledgePointId: text('knowledge_point_id').references(() => knowledgePoints.id),
  // 提问时引用的一段内容（在讲解或题目里选中的文字）
  quote: text('quote'),
  question: text('question').notNull(),
  answer: text('answer').notNull(),
  createdAt: timestamp('created_at').notNull(),
});
