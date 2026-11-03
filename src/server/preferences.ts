import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { illustratorFromConfig, modelFromConfig } from '../ai/gateway';
import { type AiSettingsPatch, mergeAiSettings, publicAiSettings, readAiSettings, writeAiSettings } from '../ai-settings';
import { CORE_FORMS, EXPLAIN_FORMS, FORM_INFO, QUESTION_FORMS, STAGE_QUESTION_FORMS } from '../domain/forms';
import { enqueue } from '../jobs/queue';
import { type UserSettings, readUserSettings, writeUserSettings } from '../settings';
import { DEFAULT_CONTENT_GUIDANCE, GUIDANCE_MAX_LENGTH, resolveContentGuidance, sameContentGuidance } from '../shared/content-guidance';
import type { Db } from '../store/db';
import { items, sessions } from '../store/schema';
import { dayFormatter, timeFormatter } from './views';

export interface PreferencesDeps {
  db: Db;
  env?: NodeJS.ProcessEnv;
}

/** 提醒时段前这么多分钟内已完成一节，就视为这个时段已学完 */
const SLOT_LEAD_MINUTES = 60;

const STAGE_LABELS = { understand: '理解（讲解后的小题）', recall: '回忆', apply: '应用', retain: '保持' } as const;

/** 设置与今天的学习安排（提醒时段、每日节数上限） */
export function createPreferences({ db, env = process.env }: PreferencesDeps) {
  /** 设置及形式目录：设置页据此列出可屏蔽、可调高的形式，核心检验形式标为不可屏蔽 */
  function getSettings() {
    return {
      settings: readUserSettings(db, env),
      guidanceDefaults: DEFAULT_CONTENT_GUIDANCE,
      guidanceMaxLength: GUIDANCE_MAX_LENGTH,
      forms: {
        explain: EXPLAIN_FORMS.map((f) => ({ id: f, label: FORM_INFO[f].label, mobile: FORM_INFO[f].mobile })),
        question: QUESTION_FORMS.map((f) => ({
          id: f,
          label: FORM_INFO[f].label,
          mobile: FORM_INFO[f].mobile,
          core: CORE_FORMS.includes(f),
          stages: Object.entries(STAGE_QUESTION_FORMS)
            .filter(([, s]) => s.forms.includes(f))
            .map(([stage, s]) => ({ stage: STAGE_LABELS[stage as keyof typeof STAGE_LABELS], core: s.core === f })),
        })),
      },
    };
  }

  /** 保存设置；强度或引导词变化时重新准备尚未开始的内容。 */
  function updateSettings(patch: Partial<UserSettings>, now: Date) {
    return db.transaction((tx) => {
      const before = readUserSettings(tx, env);
      const saved = writeUserSettings(tx, patch, now, env);
      if (before.reviewIntensity !== saved.reviewIntensity || !sameContentGuidance(resolveContentGuidance(before), resolveContentGuidance(saved))) {
        tx.update(items).set({ status: 'void' }).where(and(eq(items.status, 'pooled'), inArray(items.kind, ['lesson', 'review']))).run();
      }
      enqueue(tx, 'fill_pool', { now: now.toISOString() }, now, { dedupe: true });
      return saved;
    });
  }

  /**
   * 今天的学习安排：已完成几节、上限，以及每个提醒时段是否已学完。
   * 某时段前 60 分钟起到下一个时段之前完成过一节，这个时段就算学完，到点不再提醒。
   */
  function today(now: Date, timeZone: string) {
    const settings = readUserSettings(db, env);
    const dayOf = dayFormatter(timeZone);
    const timeOf = timeFormatter(timeZone);
    const todayKey = dayOf(now);
    const finishedTimes = db
      .select({ finishedAt: sessions.finishedAt })
      .from(sessions)
      .where(isNotNull(sessions.finishedAt))
      .all()
      .filter((s) => dayOf(s.finishedAt!) === todayKey)
      .map((s) => minutesOf(timeOf(s.finishedAt!)));
    const slots = [...settings.reminderTimes].sort();
    return {
      date: todayKey,
      now: timeOf(now),
      sessionsToday: finishedTimes.length,
      dailySessionCap: settings.dailySessionCap,
      slots: slots.map((time, i) => {
        const from = minutesOf(time) - SLOT_LEAD_MINUTES;
        const to = i + 1 < slots.length ? minutesOf(slots[i + 1]!) - SLOT_LEAD_MINUTES : 24 * 60;
        return { time, done: finishedTimes.some((m) => m >= from && m < to) };
      }),
    };
  }

  /** AI 模型配置（密钥只给末 4 位） */
  function getAiSettings() {
    return publicAiSettings(readAiSettings(db, env));
  }

  /** 保存 AI 模型配置，下一次调用模型就按新配置；补一次候选池，刚配好模型时就开始备课 */
  function updateAiSettings(patch: AiSettingsPatch, now: Date) {
    const saved = writeAiSettings(db, patch, now, env);
    enqueue(db, 'fill_pool', { now: now.toISOString() }, now, { dedupe: true });
    return publicAiSettings(saved);
  }

  /**
   * 用表单里的配置（合并到已保存的配置上，不保存）真实调用一次模型，确认能用。
   * 文本模型回一句话；画图模型画一张小图，大约要半分钟。
   */
  async function testAi(target: 'text' | 'image', patch: AiSettingsPatch): Promise<{ ok: boolean; message: string; seconds: number; image?: string }> {
    const started = Date.now();
    const seconds = () => Math.round((Date.now() - started) / 100) / 10;
    try {
      const config = mergeAiSettings(readAiSettings(db, env), patch);
      if (target === 'text') {
        const { reply } = await modelFromConfig(config.text).generate({
          name: 'connection_test',
          schema: z.object({ reply: z.string() }),
          system: '你是连接测试助手。',
          prompt: '请只回复"连接正常"四个字。',
        });
        return { ok: true, message: `模型回复：${reply}`, seconds: seconds() };
      }
      const illustrator = illustratorFromConfig(config.image, config.text);
      if (!illustrator) return { ok: false, message: '还没有填写画图模型的模型名称', seconds: 0 };
      const image = await illustrator.draw({ prompt: TEST_IMAGE_PROMPT, size: '1024x1024' });
      return { ok: true, message: '画图正常', seconds: seconds(), image: `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}` };
    } catch (error) {
      const message = error instanceof z.ZodError ? error.issues.map((i) => i.message).join('；') : (error as Error).message;
      return { ok: false, message, seconds: seconds() };
    }
  }

  return { getSettings, updateSettings, today, getAiSettings, updateAiSettings, testAi };
}

/** 测试画图用的提示词：一张简单的小图 */
const TEST_IMAGE_PROMPT = '画一株刚长出两片叶子的小苗，主体完整，背景简洁。';

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}

export type Preferences = ReturnType<typeof createPreferences>;
