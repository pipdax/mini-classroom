import { type KeyboardEvent, useEffect, useState } from 'react';
import { type SettingsSaveOptions, type SettingsView, type UserSettings, api } from '../api';
import { useResource } from '../hooks';
import { notificationPermission, requestNotificationPermission, showReminder } from '../reminders';
import { Section } from '../components/SettingsSection';
import { type PersonalizationTab, navigate } from '../router';
import { ContentGuidanceSettings } from './ContentGuidanceSettings';

/** 学习偏好和提示词分开展示，切换标签时保留正在编辑的内容。 */
export function PersonalizationScreen({ tab }: { tab: PersonalizationTab }) {
  const resource = useResource(() => api.settings(), []);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [stamp, setStamp] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (resource.data) setSettings(resource.data.settings);
  }, [resource.data]);

  function selectTab(next: PersonalizationTab) {
    navigate({ name: 'personalization', tab: next });
  }

  function handleTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    let next: PersonalizationTab;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = tab === 'learning' ? 'prompts' : 'learning';
    else if (event.key === 'Home') next = 'learning';
    else if (event.key === 'End') next = 'prompts';
    else return;
    event.preventDefault();
    selectTab(next);
    document.getElementById(`personalization-tab-${next}`)?.focus();
  }

  async function save(patch: Partial<UserSettings>, options: SettingsSaveOptions = {}) {
    const before = settings;
    if (!before) return false;
    // 先在界面上改过来，再保存；保存失败时退回原值
    setSettings((current) => current && { ...current, ...patch });
    setError('');
    setStamp(options.applyToCurrentSession ? '正在更新本次课程…' : '保存中…');
    try {
      const saved = await api.saveSettings(patch, options);
      setSettings((current) => current && { ...current, ...changedSettings(saved, patch) });
      setStamp(`已保存 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
      return true;
    } catch (e) {
      setSettings((current) => current && { ...current, ...changedSettings(before, patch) });
      setStamp('');
      setError((e as Error).message);
      return false;
    }
  }

  return (
    <>
      <div className="title-row">
        <div>
          <h1>个性化</h1>
          <p className="sub">调整学习安排，以及教程和配图的表达方式。</p>
        </div>
        <span className="muted small" role="status">
          {error ? <span className="error-text">{error}</span> : stamp}
        </span>
      </div>
      <div className="personalization-tabs" role="tablist" aria-label="个性化分类">
        <button type="button" role="tab" id="personalization-tab-learning" aria-controls="personalization-panel-learning" aria-selected={tab === 'learning'} tabIndex={tab === 'learning' ? 0 : -1} onClick={() => selectTab('learning')} onKeyDown={handleTabKey}>
          课堂学习
        </button>
        <button type="button" role="tab" id="personalization-tab-prompts" aria-controls="personalization-panel-prompts" aria-selected={tab === 'prompts'} tabIndex={tab === 'prompts' ? 0 : -1} onClick={() => selectTab('prompts')} onKeyDown={handleTabKey}>
          个性化提示词
        </button>
      </div>
      {resource.error && <p className="error-text">{resource.error}</p>}
      {settings && resource.data && (
        <>
          <div role="tabpanel" id="personalization-panel-learning" aria-labelledby="personalization-tab-learning" hidden={tab !== 'learning'}>
            <p className="muted small personalization-note">改动会自动保存，用于安排后续课堂。</p>
            <Pace settings={settings} save={save} />
            <ReviewIntensitySettings settings={settings} save={save} />
            <Reminders settings={settings} save={save} />
            <Forms settings={settings} forms={resource.data.forms} save={save} />
            <Revisit settings={settings} save={save} />
          </div>
          <div role="tabpanel" id="personalization-panel-prompts" aria-labelledby="personalization-tab-prompts" hidden={tab !== 'prompts'}>
            <ContentGuidanceSettings
              settings={settings}
              defaults={resource.data.guidanceDefaults}
              maxLength={resource.data.guidanceMaxLength}
              onSaved={(saved) => {
                setSettings((current) => current && {
                  ...current,
                  tutorialGuidance: saved.tutorialGuidance,
                  figureGuidance: saved.figureGuidance,
                });
                setError('');
                setStamp('引导词已保存');
              }}
            />
          </div>
        </>
      )}
    </>
  );
}

/** 只取本次修改的字段，避免延迟响应覆盖其他编辑区刚保存的内容。 */
function changedSettings(source: UserSettings, patch: Partial<UserSettings>): Partial<UserSettings> {
  return Object.fromEntries(Object.keys(patch).map((key) => [key, source[key as keyof UserSettings]]));
}

type SectionProps = { settings: UserSettings; save: (patch: Partial<UserSettings>, options?: SettingsSaveOptions) => Promise<boolean> };

/** 用两档清楚表达复习次数和作答负担的差异，沿用自动保存。 */
export function ReviewIntensitySettings({ settings, save }: SectionProps) {
  const [applyToCurrentSession, setApplyToCurrentSession] = useState(false);
  const [saving, setSaving] = useState(false);
  const low = settings.reviewIntensity === 'low';

  async function changeIntensity(reviewIntensity: UserSettings['reviewIntensity'], apply = applyToCurrentSession) {
    if (saving) return false;
    setSaving(true);
    try {
      return await save({ reviewIntensity }, { applyToCurrentSession: apply });
    } finally {
      setSaving(false);
    }
  }

  async function changeScope(checked: boolean) {
    setApplyToCurrentSession(checked);
    // 先选档位再勾选也会立即应用，无需重新点一次档位。
    if (checked && !await changeIntensity(settings.reviewIntensity, true)) setApplyToCurrentSession(false);
  }

  return (
    <Section title="复习强度" description="选择复习频率和考查形式。默认改动从下一节生效，正在进行的课堂保持原样。">
      <div className="actions-row">
        <div className="segmented" role="group" aria-label="复习强度">
          <button type="button" aria-pressed={low} disabled={saving} onClick={() => changeIntensity('low')}>低 · 轻量巩固</button>
          <button type="button" aria-pressed={!low} disabled={saving} onClick={() => changeIntensity('high')}>高 · 持续巩固</button>
        </div>
        <label className="check">
          <input type="checkbox" checked={applyToCurrentSession} disabled={saving} onChange={(event) => changeScope(event.target.checked)} />
          同时修改本次课程
        </label>
      </div>
      <p className="hint">勾选后立即按所选强度调整本节尚未作答的内容，保留讲解和已作答记录。之后切换档位也会同步；取消勾选只影响后续操作。</p>
      <p className="hint" aria-live="polite">
        {low
          ? '首次选择题答对并自评轻松后，不再自动复习。有过困难或仅达到良好的内容，连续两次在不同日期答对且最后一次轻松后，完成轻量巩固。小题和常规复习使用选择题，遇到误解会先重新讲清楚。'
          : '按掌握情况持续安排间隔复习：轻松内容的间隔逐渐拉长，需要巩固的内容继续确认，结合选择、简答和应用题等形式检验。'}
      </p>
    </Section>
  );
}

function Pace({ settings, save }: SectionProps) {
  return (
    <Section title="学习节奏" description="一节微课堂的时长，以及每节最多学几个新知识点。到期复习多时，新学会自动减少；复习积压超过 3 节的量时暂停新学。">
      <div className="settings-field-grid">
        <div className="field">
          <span className="label">一节的时长</span>
          <div className="segmented" role="group" aria-label="一节的时长">
            {[5, 10, 15, 20].map((m) => (
              <button key={m} type="button" aria-pressed={settings.sessionMinutes === m} onClick={() => save({ sessionMinutes: m })}>
                {m} 分钟
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="label">每节最多的新知识点</span>
          <div className="segmented" role="group" aria-label="每节最多的新知识点">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" aria-pressed={settings.maxNewPerSession === n} onClick={() => save({ maxNewPerSession: n })}>
                {n} 个
              </button>
            ))}
          </div>
          <span className="hint">每节至少有 1 个新知识点（复习积压时除外）。</span>
        </div>
      </div>
    </Section>
  );
}

function Reminders({ settings, save }: SectionProps) {
  const [time, setTime] = useState('13:30');
  const [permission, setPermission] = useState(notificationPermission());
  const capOn = settings.dailySessionCap !== null;

  return (
    <Section
      title="提醒时段"
      description="每天固定的学习时刻，比如午饭后 13:30。到点发系统通知；这个时段已经学过一节就不提醒。漏掉的不补，到期内容顺延到下一节。"
    >
      <div className="field">
        <span className="label">时段</span>
        <div className="time-chips">
          {settings.reminderTimes.length === 0 && <span className="muted">还没有提醒时段</span>}
          {[...settings.reminderTimes].sort().map((t) => (
            <span key={t} className="pill" style={{ height: 32, paddingRight: 4 }}>
              <span className="num">{t}</span>
              <button
                type="button"
                className="btn small ghost"
                style={{ height: 24, padding: '0 8px' }}
                aria-label={`删除 ${t}`}
                onClick={() => save({ reminderTimes: settings.reminderTimes.filter((x) => x !== t) })}
              >
                删除
              </button>
            </span>
          ))}
        </div>
        <div className="actions-row" style={{ marginTop: 4 }}>
          <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ width: 140 }} aria-label="新的提醒时刻" />
          <button
            type="button"
            className="btn"
            disabled={!time || settings.reminderTimes.includes(time) || settings.reminderTimes.length >= 6}
            onClick={() => save({ reminderTimes: [...settings.reminderTimes, time] })}
          >
            添加时段
          </button>
        </div>
      </div>

      <div className="switch-row">
        <div>
          <div className="sr-title">
            系统通知
            <span className={`pill ${permission === 'granted' ? 'pos' : ''}`}>
              {{ granted: '已允许', denied: '已被浏览器拒绝', default: '未开启', unsupported: '浏览器不支持' }[permission]}
            </span>
          </div>
          <div className="sr-desc">本机运行，没有推送服务器：页面或安装的应用开着时才会提醒。</div>
        </div>
        {permission === 'default' && (
          <button type="button" className="btn small" onClick={async () => setPermission(await requestNotificationPermission())}>
            允许通知
          </button>
        )}
        {permission === 'granted' && (
          <button type="button" className="btn small ghost" onClick={() => showReminder('这是一条测试提醒。')}>
            试一下
          </button>
        )}
      </div>
      <div className="preview-note" aria-label="通知预览">
        <div className="pn-title">微课堂</div>
        <div className="muted">{[...settings.reminderTimes].sort()[0] ?? '13:30'} 到了，来一节微课堂吧。</div>
      </div>

      <div className="switch-row">
        <div>
          <div className="sr-title">每日节数上限</div>
          <div className="sr-desc">达到上限后，当天不再开新的一节。</div>
        </div>
        <input type="checkbox" className="switch" checked={capOn} onChange={(e) => save({ dailySessionCap: e.target.checked ? 3 : null })} aria-label="每日节数上限" />
      </div>
      {capOn && (
        <div className="segmented" role="group" aria-label="每天最多几节">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <button key={n} type="button" aria-pressed={settings.dailySessionCap === n} onClick={() => save({ dailySessionCap: n })}>
              {n} 节
            </button>
          ))}
        </div>
      )}
    </Section>
  );
}

function Forms({ settings, forms, save }: SectionProps & { forms: SettingsView['forms'] }) {
  const blocked = new Set(settings.blockedForms as string[]);
  const boosted = new Set(settings.boostedExplainForms as string[]);
  const toggleBlocked = (id: string, on: boolean) =>
    save({ blockedForms: (on ? [...blocked, id] : [...blocked].filter((f) => f !== id)) as UserSettings['blockedForms'] });
  const toggleBoosted = (id: string, on: boolean) =>
    save({ boostedExplainForms: (on ? [...boosted, id] : [...boosted].filter((f) => f !== id)) as UserSettings['boostedExplainForms'] });

  return (
    <Section
      title="形式偏好"
      description={settings.reviewIntensity === 'low'
        ? '低档的小题和常规复习使用选择题。讲解偏好照常生效，下面的其他检验形式偏好会保留，切回高档时使用。'
        : '可以少出不喜欢的形式，或多用某些讲解形式。偏好只为减少烦躁，不承诺提升效果。核心检验形式保证检验的严格度，不能屏蔽。'}
    >
      <div className="settings-field-grid">
        <div className="field">
          <span className="label">讲解形式</span>
          {forms.explain.map((f) => (
            <div key={f.id} className="switch-row" style={{ padding: '6px 0' }}>
              <div className="sr-title">{f.label}</div>
              <div style={{ display: 'flex', gap: 16 }}>
                <label className="check" style={{ padding: 0 }}>
                  <input type="checkbox" checked={boosted.has(f.id)} disabled={blocked.has(f.id)} onChange={(e) => toggleBoosted(f.id, e.target.checked)} />
                  多用
                </label>
                <label className="check" style={{ padding: 0 }}>
                  <input type="checkbox" checked={blocked.has(f.id)} onChange={(e) => toggleBlocked(f.id, e.target.checked)} />
                  不出
                </label>
              </div>
            </div>
          ))}
        </div>
        <div className="field">
          <span className="label">检验形式</span>
          {forms.question.map((f) => (
            <div key={f.id} className="switch-row" style={{ padding: '6px 0' }}>
              <div>
                <div className="sr-title">
                  {f.label}
                  {f.core && <span className="pill accent">核心检验</span>}
                </div>
                <div className="sr-desc">
                  用于{f.stages.map((s) => s.stage).join('、')}
                  {f.mobile ? '' : ' · 需要键盘，手机上不出'}
                </div>
              </div>
              <label className="check" style={{ padding: 0 }}>
                <input type="checkbox" checked={blocked.has(f.id)} disabled={f.core || settings.reviewIntensity === 'low'} onChange={(e) => toggleBlocked(f.id, e.target.checked)} />
                不出
              </label>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}

function Revisit({ settings, save }: SectionProps) {
  return (
    <Section title="主题回访" description="每隔一段时间，在一节微课堂结束时问你：暂停的主题里，有哪些想恢复学习。">
      <div className="field">
        <span className="label">回访间隔</span>
        <div className="segmented" role="group" aria-label="回访间隔">
          {[7, 14, 30].map((d) => (
            <button key={d} type="button" aria-pressed={settings.revisitIntervalDays === d} onClick={() => save({ revisitIntervalDays: d })}>
              {d} 天
            </button>
          ))}
        </div>
      </div>
    </Section>
  );
}
