import type { ReviewIntensity } from './review';

/** 理解阶段日常轮换的讲解形式 */
export const EXPLAIN_FORMS = [
  'explain_direct',
  'explain_analogy',
  'explain_counterexample',
  'explain_diagram',
  'explain_steps',
  'explain_predict',
] as const;

/** 对比讲解：答错且错误类型是误解时触发，不参与日常轮换，也不能屏蔽 */
export const CONTRAST_FORM = 'explain_contrast';

/** 检验形式 */
export const QUESTION_FORMS = ['mcq', 'short_answer', 'pick_line', 'complete', 'fix'] as const;

export type ExplainForm = (typeof EXPLAIN_FORMS)[number] | typeof CONTRAST_FORM;
export type QuestionForm = (typeof QUESTION_FORMS)[number];
export type Form = ExplainForm | QuestionForm;

/** 有检验形式的掌握阶段（理解阶段指讲解后的当场小题） */
export type CheckStage = 'understand' | 'recall' | 'apply' | 'retain';

interface FormInfo {
  label: string;
  /** 是否适合在手机上完成：需要大段输入代码的形式不适合 */
  mobile: boolean;
}

export const FORM_INFO: Record<Form, FormInfo> = {
  explain_direct: { label: '直接讲解', mobile: true },
  explain_analogy: { label: '类比讲解', mobile: true },
  explain_counterexample: { label: '反例讲解', mobile: true },
  explain_diagram: { label: '图解', mobile: true },
  explain_steps: { label: '分步揭示', mobile: true },
  explain_predict: { label: '预测揭晓', mobile: true },
  explain_contrast: { label: '对比讲解', mobile: true },
  mcq: { label: '选择题', mobile: true },
  short_answer: { label: '简答', mobile: true },
  pick_line: { label: '点选错误行', mobile: true },
  complete: { label: '补全', mobile: false },
  fix: { label: '修正', mobile: false },
};

/**
 * 各掌握阶段的检验形式池。core 是核心检验形式：保证检验的严格度，不能被屏蔽。
 * - 理解：讲解后的当场小题，检验是否听懂；
 * - 回忆：间隔后强迫回忆，选择题的干扰项取自易混关系；
 * - 应用：类似真实工作的补全、修正、找错任务；
 * - 保持：长周期混合各种形式验证。
 */
export const STAGE_QUESTION_FORMS: Record<CheckStage, { forms: readonly QuestionForm[]; core: QuestionForm }> = {
  understand: { forms: ['mcq', 'short_answer'], core: 'mcq' },
  recall: { forms: ['mcq', 'short_answer', 'pick_line'], core: 'short_answer' },
  apply: { forms: ['fix', 'complete', 'pick_line'], core: 'fix' },
  retain: { forms: ['short_answer', 'mcq', 'pick_line', 'complete', 'fix'], core: 'short_answer' },
};

/** 用户的形式偏好：可屏蔽不想要的形式，可调高某些讲解形式 */
export interface FormPrefs {
  blocked: readonly string[];
  boosted: readonly string[];
}

export const NO_PREFS: FormPrefs = { blocked: [], boosted: [] };

/** 所有核心检验形式：设置偏好时不允许屏蔽 */
export const CORE_FORMS: readonly QuestionForm[] = [...new Set(Object.values(STAGE_QUESTION_FORMS).map((s) => s.core))];

export function isMobileForm(form: string): boolean {
  return FORM_INFO[form as Form]?.mobile ?? false;
}

/**
 * 某阶段此刻可用的检验形式：去掉被屏蔽的（核心形式不受屏蔽影响），在手机上只留适合手机的。
 * 全部被去掉时退回核心形式，保证总有一种可用。
 * 低档统一用选择题，高档再按阶段和形式偏好挑选。
 */
export function questionFormsFor(stage: CheckStage, prefs: FormPrefs, mobile = false, intensity: ReviewIntensity = 'high'): QuestionForm[] {
  if (intensity === 'low') return ['mcq'];
  const { forms, core } = STAGE_QUESTION_FORMS[stage];
  const allowed = forms.filter((f) => (f === core || !prefs.blocked.includes(f)) && (!mobile || isMobileForm(f)));
  if (allowed.length > 0) return allowed;
  return mobile && !isMobileForm(core) ? ['mcq'] : [core];
}

/** 此刻可用的讲解形式：去掉被屏蔽的；全部屏蔽时退回直接讲解 */
export function explainFormsFor(prefs: FormPrefs): ExplainForm[] {
  const allowed = EXPLAIN_FORMS.filter((f) => !prefs.blocked.includes(f));
  return allowed.length > 0 ? allowed : ['explain_direct'];
}

/** 按固定顺序轮换，返回与上次不同的下一种形式；没有上次记录、或上次的形式不在列表里时取第一种。 */
export function nextForm<F extends string>(forms: readonly F[], last: string | null): F {
  const index = last === null ? -1 : forms.indexOf(last as F);
  return forms[(index + 1) % forms.length]!;
}

/**
 * 从可用形式中挑一种与上次不同的：调高偏好的形式优先，其余按固定顺序轮换。
 * 只有一种可用时，即使与上次相同也只能用它。
 */
export function pickForm<F extends string>(available: readonly F[], last: string | null, boosted: readonly string[] = []): F {
  const boostedChoice = available.find((f) => f !== last && boosted.includes(f));
  return boostedChoice ?? nextForm(available, last);
}
