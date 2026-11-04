import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { z } from 'zod';
import { AiSettingsPatchSchema } from '../ai-settings';
import { UserSettingsSchema } from '../settings';
import { TopicIdeaSchema } from '../shared/topic-planning';
import type { Services } from './services';
import { LearningError } from './views';

export interface AppDeps {
  services: Services;
  clock: () => Date;
  /** 开发模式下允许用 X-Dev-Now 请求头覆盖当前时间，用于验收"第二天" */
  devMode: boolean;
  /** 前端页面地址；直接打开服务端根路径时跳转过去。未知时返回 null */
  frontendUrl?: () => string | null;
  /** 安装版的正式页面目录；不提供时保持源码版的前后端分离运行。 */
  webRoot?: string;
}

const STAGES = ['unlearned', 'inferred', 'understand', 'recall', 'apply', 'retain'] as const;

const TopicBody = z.object({ title: z.string().trim().min(1, '请输入学习主题').max(100, '主题名称不超过 100 字') });
const TopicDraftBody = z.object({ idea: TopicIdeaSchema });
const DraftRevisionBody = z.object({ revision: z.number().int().nonnegative() });
const TopicMessageBody = DraftRevisionBody.extend({ message: TopicIdeaSchema });
const TopicPatch = z
  .object({ status: z.enum(['active', 'paused']).optional(), priority: z.number().int().min(1).max(3).optional() })
  .refine((p) => p.status !== undefined || p.priority !== undefined, '没有要修改的内容');
const PlacementBody = z.object({ background: z.string().trim().max(500, '背景自述不超过 500 字') });
const PlacementAnswerBody = z.object({ pointId: z.string(), choice: z.number().int().min(-1) });
const NextSessionBody = z.object({
  // 可选的补充说明；全是空白时当作没写
  guidance: z.string().trim().max(500, '补充说明不超过 500 字').optional(),
  device: z.enum(['desktop', 'mobile']).optional(),
  timeZone: z.string().optional(),
  fresh: z.boolean().optional(),
});
const PreviewQuery = z.object({ device: z.enum(['desktop', 'mobile']).optional(), timeZone: z.string().optional() });
const AttemptBody = z.object({
  sessionId: z.string(),
  itemId: z.string(),
  answer: z.union([z.object({ choice: z.number().int() }), z.object({ text: z.string() })]),
  durationMs: z.number().int().nonnegative().optional(),
});
const RatingBody = z.object({ selfRating: z.enum(['hard', 'good', 'easy']) });
const AppealBody = z.object({ reason: z.string().trim().min(1, '请写明申诉理由').max(1000, '申诉理由不超过 1000 字') });
const ThreadBody = z.object({ sessionId: z.string().optional(), pointId: z.string().optional() });
const ThreadQuery = z.object({ sessionId: z.string().optional(), pointId: z.string().optional() });
const AskBody = z.object({
  threadId: z.string(),
  itemId: z.string().optional(),
  pointId: z.string().optional(),
  quote: z.string().trim().max(2000, '引用的内容不超过 2000 字').optional(),
  question: z.string().trim().min(1, '请输入问题').max(1000, '问题不超过 1000 字'),
});
const SuggestBody = z.object({ hint: z.string().trim().max(100, '附加说明不超过 100 字').optional() });
const AcceptBody = z.object({
  anchorPointId: z.string(),
  points: z
    .array(z.object({ title: z.string().trim().min(1).max(60), summary: z.string().trim().min(1).max(300), kind: z.enum(['prerequisite', 'extension']) }))
    .min(1, '请至少选一个知识点')
    .max(4),
});
const RevisitBody = z.object({ resumeTopicIds: z.array(z.string()) });
const RelearnBody = z.object({ knowledgePointIds: z.array(z.string()).min(1, '请选择要重新学习的知识点') });
const LearningChoiceBody = z.object({ excluded: z.boolean() });
const ExistingBody = z.object({ text: z.string().trim().min(1, '请输入已有知识').max(100, '已有知识不超过 100 字') });
const CheatsheetBody = z.object({ topicIds: z.array(z.string()).min(1, '请选择至少一个学习主题'), stages: z.array(z.enum(STAGES)).optional() });
const ExportBody = z.object({ topicIds: z.array(z.string()).min(1, '请选择至少一个学习主题'), records: z.boolean(), cheatsheetId: z.string().optional() });
const ReviewQuery = z.object({ timeZone: z.string().min(1), topicId: z.string().optional() });
const TimeZoneQuery = z.object({ timeZone: z.string().min(1) });
const DayParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
const SettingsPatch = UserSettingsSchema.partial().extend({ applyToCurrentSession: z.boolean().optional() })
  .refine((patch) => !patch.applyToCurrentSession || patch.reviewIntensity !== undefined, '修改本次课程时请指定复习强度');
const AiTestBody = z.object({ target: z.enum(['text', 'image']), patch: AiSettingsPatchSchema.default({}) });

/** 组装 HTTP 应用；依赖由调用方注入，便于测试。 */
export function createApp({ services, clock, devMode, frontendUrl, webRoot }: AppDeps) {
  const { learning, topicPlanning, knowledge, placement, preferences, asking, illustrations } = services;
  const app = new Hono();

  // 只监听本机仍会收到恶意网页的请求；同时限制 Host、来源和浏览器跨站访问。
  app.use('*', async (c, next) => {
    const requestUrl = new URL(c.req.url);
    const host = c.req.header('Host');
    if (!isLocalHttpUrl(requestUrl) || (host && host.toLowerCase() !== requestUrl.host)) {
      return c.json({ error: '只允许通过本机地址访问' }, 403);
    }
    if (c.req.header('Sec-Fetch-Site') === 'cross-site') {
      return c.json({ error: '不允许跨站访问本机服务' }, 403);
    }
    const origin = c.req.header('Origin');
    if (origin) {
      const frontend = frontendUrl?.();
      let frontendOrigin: string | undefined;
      if (frontend) {
        const url = new URL(frontend);
        if (isLocalHttpUrl(url)) frontendOrigin = url.origin;
      }
      if (origin !== requestUrl.origin && origin !== frontendOrigin) {
        return c.json({ error: '请求来源不是微课堂页面' }, 403);
      }
    }
    await next();
  });

  const nowOf = (header: string | undefined) => {
    if (!devMode || !header) return clock();
    const date = new Date(header);
    if (Number.isNaN(date.getTime())) throw new LearningError('X-Dev-Now 不是合法的时间', 400);
    return date;
  };
  const now = (c: { req: { header(name: string): string | undefined } }) => nowOf(c.req.header('X-Dev-Now'));
  const body = async <T>(c: { req: { json(): Promise<unknown>; header(name: string): string | undefined } }, schema: z.ZodType<T>) => {
    const contentType = c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') throw new LearningError('请求体必须使用 application/json', 415);
    return schema.parse(await c.req.json().catch(() => ({})));
  };

  app.onError((error, c) => {
    if (error instanceof LearningError) return c.json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return c.json({ error: error.issues.map((i) => i.message).join('；') }, 400);
    console.error(error);
    return c.json({ error: '服务内部错误' }, 500);
  });

  // 服务端只提供 /api 接口；有人直接打开服务端地址时，带去前端页面而不是显示 404
  if (!webRoot) {
    app.get('/', (c) => {
      const url = frontendUrl?.() ?? null;
      return url ? c.redirect(url) : c.text('这是微课堂的接口服务，页面请打开前端地址（start.sh 启动时会打印）。');
    });
  }

  app.get('/api/health', (c) => c.json({ ok: true, devMode }));

  // ---------- 学习主题与摸底诊断 ----------

  app.get('/api/topic-drafts', c => c.json({ drafts: topicPlanning.list() }));
  app.post('/api/topic-drafts', async c => c.json(topicPlanning.create((await body(c, TopicDraftBody)).idea, now(c)), 201));
  app.get('/api/topic-drafts/:id', c => c.json(topicPlanning.get(c.req.param('id'))));
  app.post('/api/topic-drafts/:id/messages', async c => {
    const { message, revision } = await body(c, TopicMessageBody);
    return c.json(topicPlanning.addMessage(c.req.param('id'), message, revision, now(c)), 201);
  });
  app.post('/api/topic-drafts/:id/reply', async c =>
    c.json(await topicPlanning.reply(c.req.param('id'), (await body(c, DraftRevisionBody)).revision, now(c))),
  );
  app.post('/api/topic-drafts/:id/confirm', async c =>
    c.json(await topicPlanning.confirm(c.req.param('id'), (await body(c, DraftRevisionBody)).revision, now(c))),
  );

  app.get('/api/topics', (c) => c.json({ topics: learning.listTopics() }));
  app.post('/api/topics', async (c) => c.json(learning.startTopic((await body(c, TopicBody)).title, now(c)), 201));
  app.patch('/api/topics/:id', async (c) => c.json(learning.updateTopic(c.req.param('id'), await body(c, TopicPatch), now(c))));

  app.get('/api/topics/:id/placement', (c) => c.json(placement.status(c.req.param('id'), now(c))));
  app.post('/api/topics/:id/placement', async (c) =>
    c.json(placement.begin(c.req.param('id'), (await body(c, PlacementBody)).background, now(c))),
  );
  app.post('/api/topics/:id/placement/answer', async (c) => {
    const { pointId, choice } = await body(c, PlacementAnswerBody);
    return c.json(placement.answer(c.req.param('id'), pointId, choice, now(c)));
  });
  app.post('/api/topics/:id/placement/skip', (c) => c.json(placement.skip(c.req.param('id'), now(c))));

  // ---------- 微课堂 ----------

  app.get('/api/sessions/preview', (c) => {
    const { device, timeZone } = PreviewQuery.parse(c.req.query());
    return c.json(learning.previewNext(now(c), { device, timeZone }));
  });
  app.post('/api/sessions/next', async (c) => {
    const { guidance, device, timeZone, fresh } = await body(c, NextSessionBody);
    return c.json(await learning.nextSession(now(c), { guidance: guidance || undefined, device, timeZone, fresh }));
  });
  app.post('/api/sessions/:id/finish', (c) => c.json(learning.finishSession(c.req.param('id'), now(c))));
  app.post('/api/attempts', async (c) => c.json(await learning.submitAttempt(await body(c, AttemptBody), now(c)), 201));
  app.post('/api/attempts/:id/rating', async (c) =>
    c.json(learning.rateAttempt(c.req.param('id'), (await body(c, RatingBody)).selfRating, now(c))),
  );
  app.post('/api/attempts/:id/appeal', async (c) =>
    c.json(await learning.appealAttempt(c.req.param('id'), (await body(c, AppealBody)).reason, now(c))),
  );
  app.get('/api/ask-threads', (c) => c.json({ threads: asking.listThreads(ThreadQuery.parse(c.req.query())) }));
  app.post('/api/ask-threads', async (c) => c.json(asking.createThread(await body(c, ThreadBody), now(c)), 201));
  app.post('/api/ask-threads/:id/suggest', async (c) => {
    const { hint } = await body(c, SuggestBody);
    return c.json(await asking.suggest(c.req.param('id'), hint || undefined));
  });
  app.post('/api/asks', async (c) => {
    const input = await body(c, AskBody);
    return c.json(await asking.ask({ ...input, quote: input.quote || undefined }, now(c)), 201);
  });
  app.post('/api/asks/accept', async (c) => c.json(asking.accept(await body(c, AcceptBody), now(c)), 201));
  app.post('/api/revisit', async (c) => c.json(learning.answerRevisit((await body(c, RevisitBody)).resumeTopicIds, now(c))));

  // ---------- 认知地图、回看、重新学习 ----------

  app.get('/api/map', (c) => c.json(knowledge.cognitiveMap(now(c))));
  app.get('/api/points/:id', (c) => c.json(knowledge.pointDetail(c.req.param('id'))));
  app.patch('/api/points/:id/learning', async (c) =>
    c.json(knowledge.setLearningExcluded(c.req.param('id'), (await body(c, LearningChoiceBody)).excluded, now(c))),
  );
  app.get('/api/review-days', (c) => c.json({ days: knowledge.reviewDays(ReviewQuery.parse(c.req.query())) }));
  app.get('/api/review-days/:day', (c) =>
    c.json(knowledge.dayReview({ day: DayParam.parse(c.req.param('day')), ...ReviewQuery.parse(c.req.query()) })),
  );
  app.post('/api/relearn', async (c) => c.json(knowledge.relearnPoints((await body(c, RelearnBody)).knowledgePointIds, now(c))));
  app.post('/api/existing-knowledge', async (c) => c.json(knowledge.addExistingKnowledge((await body(c, ExistingBody)).text, now(c)), 201));
  app.delete('/api/existing-knowledge/:id', (c) => c.json(knowledge.removeExistingKnowledge(c.req.param('id'))));

  // ---------- 速查表与导出 ----------

  app.get('/api/illustrations/:id', (c) => c.json(illustrations.status(c.req.param('id'))));
  app.post('/api/illustrations/:id/retry', (c) => c.json(illustrations.retry(c.req.param('id'), now(c))));
  app.get('/api/illustrations/:id/image', (c) => {
    const { data, mediaType } = illustrations.image(c.req.param('id'));
    // 画好后不再改变，浏览器可以一直缓存
    return c.body(new Uint8Array(data), 200, { 'Content-Type': mediaType, 'Cache-Control': 'private, max-age=31536000, immutable' });
  });

  app.get('/api/cheatsheets', (c) => c.json({ cheatsheets: knowledge.listCheatsheets() }));
  app.post('/api/cheatsheets', async (c) => c.json(knowledge.createCheatsheet(await body(c, CheatsheetBody), now(c)), 201));
  app.get('/api/cheatsheets/:id', (c) => c.json(knowledge.getCheatsheet(c.req.param('id'))));
  app.post('/api/export', async (c) => c.json(knowledge.exportMarkdown(await body(c, ExportBody), now(c))));

  // ---------- 设置与今天的安排 ----------

  app.get('/api/settings', (c) => c.json(preferences.getSettings()));
  app.put('/api/settings', async (c) => {
    const { applyToCurrentSession, ...patch } = await body(c, SettingsPatch);
    const at = now(c);
    const save = () => preferences.updateSettings(patch, at);
    return c.json(applyToCurrentSession
      ? await learning.updateCurrentReviewIntensity(patch.reviewIntensity!, at, save)
      : save());
  });
  app.get('/api/settings/ai', (c) => c.json(preferences.getAiSettings()));
  app.put('/api/settings/ai', async (c) => c.json(preferences.updateAiSettings(await body(c, AiSettingsPatchSchema), now(c))));
  app.post('/api/settings/ai/test', async (c) => {
    const { target, patch } = await body(c, AiTestBody);
    return c.json(await preferences.testAi(target, patch));
  });
  app.get('/api/today', (c) => c.json(preferences.today(now(c), TimeZoneQuery.parse(c.req.query()).timeZone)));

  // 页面与接口使用同一来源，安装版不需要开发服务器或放宽跨站限制。
  if (webRoot) {
    app.all('/api/*', (c) => c.notFound());
    app.use('*', serveStatic({ root: webRoot }));
  }
  return app;
}

/** 精确匹配本机 HTTP 地址，拒绝任意域名指向回环地址的 DNS 重绑定请求。 */
function isLocalHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && !url.username && !url.password;
}
