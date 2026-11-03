import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { CORE_FORMS, EXPLAIN_FORMS, type FormPrefs, QUESTION_FORMS } from './domain/forms';
import type { ReviewIntensity } from './domain/review';
import { type ContentGuidance, DEFAULT_CONTENT_GUIDANCE, GUIDANCE_MAX_LENGTH, resolveContentGuidance } from './shared/content-guidance';
import type { Executor } from './store/db';
import { appSettings } from './store/schema';

/** 用户在设置页可调整的学习参数 */
export const UserSettingsSchema = z.object({
  /** 复习强度：高档持续混合检验，低档完成轻量巩固后停止自动复习。 */
  reviewIntensity: z.enum(['low', 'high']),
  /** 一节微课堂的时长（分钟） */
  sessionMinutes: z.number().int().min(5, '一节至少 5 分钟').max(30, '一节最多 30 分钟'),
  /** 每节最多引入的新知识点数 */
  maxNewPerSession: z.number().int().min(1, '每节至少 1 个新知识点').max(5, '每节最多 5 个新知识点'),
  /** 每天的提醒时段，如 "13:30" */
  reminderTimes: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式应为 HH:MM')).max(6, '最多 6 个提醒时段'),
  /** 每日节数上限；null 表示不限 */
  dailySessionCap: z.number().int().min(1).max(20).nullable(),
  /** 主题回访间隔（天） */
  revisitIntervalDays: z.number().int().min(1).max(90),
  /** 屏蔽的形式：核心检验形式不能屏蔽 */
  blockedForms: z
    .array(z.enum([...EXPLAIN_FORMS, ...QUESTION_FORMS]))
    .refine((forms) => forms.every((f) => !(CORE_FORMS as readonly string[]).includes(f)), '核心检验形式不能屏蔽'),
  /** 调高偏好的讲解形式 */
  boostedExplainForms: z.array(z.enum(EXPLAIN_FORMS)),
  /** null 表示采用默认教程引导词。 */
  tutorialGuidance: z.string().trim().max(GUIDANCE_MAX_LENGTH, `教程引导词不超过 ${GUIDANCE_MAX_LENGTH} 字`).nullable(),
  /** null 表示采用默认配图引导词。 */
  figureGuidance: z.string().trim().max(GUIDANCE_MAX_LENGTH, `配图引导词不超过 ${GUIDANCE_MAX_LENGTH} 字`).nullable(),
});

export type UserSettings = z.infer<typeof UserSettingsSchema>;

export const DEFAULT_USER_SETTINGS: UserSettings = {
  reviewIntensity: 'high',
  sessionMinutes: 10,
  maxNewPerSession: 2,
  reminderTimes: [],
  dailySessionCap: null,
  revisitIntervalDays: 14,
  blockedForms: [],
  boostedExplainForms: [],
  tutorialGuidance: null,
  figureGuidance: null,
};

/** 学习流程实际使用的参数：用户设置 + 部署配置 */
export interface Settings {
  reviewIntensity: ReviewIntensity;
  /** 一节微课堂的时间预算（秒） */
  budgetSeconds: number;
  /** 每节最多引入的新知识点数 */
  maxNewPerSession: number;
  /** 补候选池时同时向模型发起的请求数（部署配置，来自环境变量） */
  generationConcurrency: number;
  reminderTimes: string[];
  dailySessionCap: number | null;
  revisitIntervalDays: number;
  formPrefs: FormPrefs;
  contentGuidance: ContentGuidance;
}

const USER_SETTINGS_KEY = 'user_settings';

/** 读取用户设置：数据库里没有的项用默认值（环境变量可覆盖默认的时长和新知识点数） */
export function readUserSettings(db: Executor, env: NodeJS.ProcessEnv = process.env): UserSettings {
  const defaults: UserSettings = {
    ...DEFAULT_USER_SETTINGS,
    sessionMinutes: env.SESSION_BUDGET_SECONDS ? Math.round(Number(env.SESSION_BUDGET_SECONDS) / 60) : DEFAULT_USER_SETTINGS.sessionMinutes,
    maxNewPerSession: env.MAX_NEW_PER_SESSION ? Number(env.MAX_NEW_PER_SESSION) : DEFAULT_USER_SETTINGS.maxNewPerSession,
  };
  const row = db.select().from(appSettings).where(eq(appSettings.key, USER_SETTINGS_KEY)).get();
  const saved = UserSettingsSchema.partial().safeParse(row?.value ?? {});
  return { ...defaults, ...(saved.success ? saved.data : {}) };
}

/** 保存用户设置：只改传入的项，校验不通过时抛出 ZodError */
export function writeUserSettings(db: Executor, patch: Partial<UserSettings>, now: Date, env: NodeJS.ProcessEnv = process.env): UserSettings {
  const next = UserSettingsSchema.parse({ ...readUserSettings(db, env), ...patch });
  if (!next.tutorialGuidance || next.tutorialGuidance === DEFAULT_CONTENT_GUIDANCE.tutorialGuidance) next.tutorialGuidance = null;
  if (!next.figureGuidance || next.figureGuidance === DEFAULT_CONTENT_GUIDANCE.figureGuidance) next.figureGuidance = null;
  db.insert(appSettings)
    .values({ key: USER_SETTINGS_KEY, value: next, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: next, updatedAt: now } })
    .run();
  return next;
}

export function toSettings(user: UserSettings, env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    reviewIntensity: user.reviewIntensity,
    budgetSeconds: user.sessionMinutes * 60,
    maxNewPerSession: user.maxNewPerSession,
    generationConcurrency: Number(env.GENERATION_CONCURRENCY ?? 3),
    reminderTimes: user.reminderTimes,
    dailySessionCap: user.dailySessionCap,
    revisitIntervalDays: user.revisitIntervalDays,
    formPrefs: { blocked: user.blockedForms, boosted: user.boostedExplainForms },
    contentGuidance: resolveContentGuidance(user),
  };
}

/** 学习流程每次读取最新设置：设置页改动后立即生效 */
export function settingsSource(db: Executor, env: NodeJS.ProcessEnv = process.env): () => Settings {
  return () => toSettings(readUserSettings(db, env), env);
}

// ---------- 少量应用状态（如上次主题回访的时间） ----------

export function readState<T>(db: Executor, key: string): T | null {
  const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get();
  return (row?.value as T | undefined) ?? null;
}

export function writeState(db: Executor, key: string, value: unknown, now: Date): void {
  db.insert(appSettings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } })
    .run();
}
