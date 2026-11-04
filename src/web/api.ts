import type { AiSettingsPatch } from '../ai-settings';
import type { Stage } from '../domain/memory';
import type { Services } from '../server/services';
import type { Answer } from '../server/views';

/** 经 JSON 传输后的形状：Date 变成 ISO 字符串，其余结构不变 */
export type Jsonify<T> = T extends Date ? string : T extends object ? { [K in keyof T]: Jsonify<T[K]> } : T;

// 接口返回类型直接取自服务端实现，前后端只维护一份
type Learning = Services['learning'];
type Knowledge = Services['knowledge'];
type PlacementService = Services['placement'];
type Preferences = Services['preferences'];
type Asking = Services['asking'];
type TopicPlanning = Services['topicPlanning'];

export type Topic = Jsonify<ReturnType<Learning['listTopics']>[number]>;
export type TopicDraft = Jsonify<ReturnType<TopicPlanning['get']>>;
export type TopicDraftSummary = Jsonify<ReturnType<TopicPlanning['list']>[number]>;
export type Preview = Jsonify<ReturnType<Learning['previewNext']>>;
export type NextSession = Jsonify<Awaited<ReturnType<Learning['nextSession']>>>;
export type Session = NonNullable<NextSession['session']>;
export type SessionItem = Session['items'][number];
export type ItemPurpose = SessionItem['purpose'];
export type AttemptResult = Jsonify<Awaited<ReturnType<Learning['submitAttempt']>>>;
export type AppealResult = Jsonify<Awaited<ReturnType<Learning['appealAttempt']>>>;
export type FinishResult = Jsonify<ReturnType<Learning['finishSession']>>;
export type CognitiveMap = Jsonify<ReturnType<Knowledge['cognitiveMap']>>;
export type MapTopic = CognitiveMap['topics'][number];
export type MapPoint = CognitiveMap['points'][number];
export type MapConnection = CognitiveMap['connections'][number];
export type PointDetail = Jsonify<ReturnType<Knowledge['pointDetail']>>;
export type LearningRecord = PointDetail['records'][number];
export type ReviewDay = Jsonify<ReturnType<Knowledge['reviewDays']>[number]>;
export type DayReview = Jsonify<ReturnType<Knowledge['dayReview']>>;
export type CheatsheetSummary = Jsonify<ReturnType<Knowledge['listCheatsheets']>[number]>;
export type Cheatsheet = Jsonify<ReturnType<Knowledge['getCheatsheet']>>;
export type PlacementState = Jsonify<ReturnType<PlacementService['status']>>;
export type SettingsView = Jsonify<ReturnType<Preferences['getSettings']>>;
export type UserSettings = SettingsView['settings'];
export interface SettingsSaveOptions {
  applyToCurrentSession?: boolean;
}
export type Today = Jsonify<ReturnType<Preferences['today']>>;
export type AiSettingsView = Jsonify<ReturnType<Preferences['getAiSettings']>>;
export type AiTestResult = Awaited<ReturnType<Preferences['testAi']>>;
export type { AiSettingsPatch };
export type AskThread = Jsonify<ReturnType<Asking['listThreads']>[number]>;
export type Ask = AskThread['asks'][number];
export type AskSuggestions = Jsonify<Awaited<ReturnType<Asking['suggest']>>>;
export type KnowledgeSuggestion = AskSuggestions['suggestions'][number];
export type { Answer, Stage };

const DEV_NOW_KEY = 'weiketang.devNow';

/** 开发模式下的"模拟当前时间"，只存在本机浏览器里 */
export const devNow = {
  get(): string {
    try {
      return localStorage.getItem(DEV_NOW_KEY) ?? '';
    } catch {
      return '';
    }
  },
  set(value: string): void {
    try {
      if (value) localStorage.setItem(DEV_NOW_KEY, value);
      else localStorage.removeItem(DEV_NOW_KEY);
    } catch {
      // 浏览器禁用存储时忽略，只是不记住模拟时间
    }
  },
};

/** 浏览器所在时区："今天""哪一天"都按它划分 */
export const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** 当前设备：窄屏或触屏视为手机，只出适合手机的形式 */
export function currentDevice(): 'desktop' | 'mobile' {
  try {
    return window.matchMedia('(max-width: 640px), (pointer: coarse)').matches ? 'mobile' : 'desktop';
  } catch {
    return 'desktop';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const simulated = devNow.get();
  if (simulated) headers['X-Dev-Now'] = new Date(simulated).toISOString();
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `请求失败（${res.status}）`);
  return data as T;
}

const query = (params: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined)).toString();

export const api = {
  health: () => request<{ ok: boolean; devMode: boolean }>('GET', '/api/health'),

  listTopics: () => request<{ topics: Topic[] }>('GET', '/api/topics'),
  topicDrafts: () => request<{ drafts: TopicDraftSummary[] }>('GET', '/api/topic-drafts'),
  createTopicDraft: (idea: string) => request<TopicDraft>('POST', '/api/topic-drafts', { idea }),
  topicDraft: (id: string) => request<TopicDraft>('GET', `/api/topic-drafts/${id}`),
  addTopicMessage: (id: string, message: string, revision: number) =>
    request<TopicDraft>('POST', `/api/topic-drafts/${id}/messages`, { message, revision }),
  replyTopicDraft: (id: string, revision: number) => request<TopicDraft>('POST', `/api/topic-drafts/${id}/reply`, { revision }),
  confirmTopicDraft: (id: string, revision: number) => request<{ topicId: string }>('POST', `/api/topic-drafts/${id}/confirm`, { revision }),
  updateTopic: (topicId: string, patch: { status?: 'active' | 'paused'; priority?: number }) =>
    request<Topic>('PATCH', `/api/topics/${topicId}`, patch),

  placement: (topicId: string) => request<PlacementState>('GET', `/api/topics/${topicId}/placement`),
  beginPlacement: (topicId: string, background: string) =>
    request<PlacementState>('POST', `/api/topics/${topicId}/placement`, { background }),
  answerPlacement: (topicId: string, pointId: string, choice: number) =>
    request<PlacementState>('POST', `/api/topics/${topicId}/placement/answer`, { pointId, choice }),
  skipPlacement: (topicId: string) => request<PlacementState>('POST', `/api/topics/${topicId}/placement/skip`),

  preview: () => request<Preview>('GET', `/api/sessions/preview?${query({ device: currentDevice(), timeZone })}`),
  /** 开始下一节；fresh 为构建新一节（提前结束未完成的一节，没备好内容时当场生成） */
  nextSession: (options: { guidance?: string; fresh?: boolean } = {}) =>
    request<NextSession>('POST', '/api/sessions/next', { ...options, device: currentDevice(), timeZone }),
  submitAttempt: (body: { sessionId: string; itemId: string; answer: Answer; durationMs: number }) =>
    request<AttemptResult>('POST', '/api/attempts', body),
  rate: (attemptId: string, selfRating: 'hard' | 'good' | 'easy') =>
    request<{ ok: boolean }>('POST', `/api/attempts/${attemptId}/rating`, { selfRating }),
  appeal: (attemptId: string, reason: string) => request<AppealResult>('POST', `/api/attempts/${attemptId}/appeal`, { reason }),
  finish: (sessionId: string) => request<FinishResult>('POST', `/api/sessions/${sessionId}/finish`),
  answerRevisit: (resumeTopicIds: string[]) => request<{ ok: boolean }>('POST', '/api/revisit', { resumeTopicIds }),

  askThreads: (scope: { sessionId?: string; pointId?: string }) =>
    request<{ threads: AskThread[] }>('GET', `/api/ask-threads?${query(scope)}`),
  createAskThread: (scope: { sessionId?: string; pointId?: string }) => request<AskThread>('POST', '/api/ask-threads', scope),
  ask: (input: { threadId: string; question: string; itemId?: string; pointId?: string; quote?: string }) => request<Ask>('POST', '/api/asks', input),
  suggestKnowledge: (threadId: string, hint?: string) => request<AskSuggestions>('POST', `/api/ask-threads/${threadId}/suggest`, { hint }),
  acceptKnowledge: (anchorPointId: string, points: KnowledgeSuggestion[]) =>
    request<{ added: number; skipped: number; topicId: string }>('POST', '/api/asks/accept', { anchorPointId, points }),

  map: () => request<CognitiveMap>('GET', '/api/map'),
  point: (pointId: string) => request<PointDetail>('GET', `/api/points/${pointId}`),
  setLearningExcluded: (pointId: string, excluded: boolean) =>
    request<{ id: string; excluded: boolean }>('PATCH', `/api/points/${pointId}/learning`, { excluded }),
  reviewDays: (topicId?: string) => request<{ days: ReviewDay[] }>('GET', `/api/review-days?${query({ timeZone, topicId })}`),
  dayReview: (day: string, topicId?: string) =>
    request<DayReview>('GET', `/api/review-days/${day}?${query({ timeZone, topicId })}`),
  relearn: (knowledgePointIds: string[]) => request<{ relearned: string[] }>('POST', '/api/relearn', { knowledgePointIds }),
  addExistingKnowledge: (text: string) => request<{ id: string; text: string }>('POST', '/api/existing-knowledge', { text }),
  removeExistingKnowledge: (id: string) => request<{ ok: boolean }>('DELETE', `/api/existing-knowledge/${id}`),

  illustration: (id: string) => request<{ status: 'pending' | 'ready' | 'failed' }>('GET', `/api/illustrations/${encodeURIComponent(id)}`),
  retryIllustration: (id: string) => request<Jsonify<ReturnType<Services['illustrations']['retry']>>>(
    'POST', `/api/illustrations/${encodeURIComponent(id)}/retry`,
  ),
  illustrationImageUrl: (id: string) => `/api/illustrations/${encodeURIComponent(id)}/image`,

  cheatsheets: () => request<{ cheatsheets: CheatsheetSummary[] }>('GET', '/api/cheatsheets'),
  cheatsheet: (id: string) => request<Cheatsheet>('GET', `/api/cheatsheets/${id}`),
  createCheatsheet: (topicIds: string[], stages: Stage[]) =>
    request<{ id: string; title: string; pointCount: number }>('POST', '/api/cheatsheets', { topicIds, stages }),
  exportMarkdown: (topicIds: string[], records: boolean, cheatsheetId?: string) =>
    request<{ filename: string; markdown: string }>('POST', '/api/export', { topicIds, records, cheatsheetId }),

  settings: () => request<SettingsView>('GET', '/api/settings'),
  saveSettings: (patch: Partial<UserSettings>, options: SettingsSaveOptions = {}) => request<UserSettings>('PUT', '/api/settings', { ...patch, ...options }),
  aiSettings: () => request<AiSettingsView>('GET', '/api/settings/ai'),
  saveAiSettings: (patch: AiSettingsPatch) => request<AiSettingsView>('PUT', '/api/settings/ai', patch),
  testAi: (target: 'text' | 'image', patch: AiSettingsPatch) => request<AiTestResult>('POST', '/api/settings/ai/test', { target, patch }),
  today: () => request<Today>('GET', `/api/today?${query({ timeZone })}`),
};

/** 把文字内容存成本地文件（导出、速查表下载） */
export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
