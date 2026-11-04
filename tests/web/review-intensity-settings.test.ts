import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_SETTINGS } from '../../src/settings';
import { ReviewIntensitySettings } from '../../src/web/screens/PersonalizationScreen';

describe('复习强度设置', () => {
  it.each(['high', 'low'] as const)('%s 档显示选中状态、生效时机和具体安排', (reviewIntensity) => {
    const html = renderToStaticMarkup(createElement(ReviewIntensitySettings, {
      settings: { ...DEFAULT_USER_SETTINGS, reviewIntensity },
      save: async () => true,
    }));
    expect(html).toContain('aria-label="复习强度"');
    expect(html).toContain('改动从下一节生效');
    expect(html).toContain('正在进行的课堂保持原样');
    expect(html).toContain('同时修改本次课程');
    expect(html).toContain('保留讲解和已作答记录');
    const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0];
    expect(checkbox).toBeDefined();
    expect(checkbox).not.toContain('checked');
    expect(html).toContain(`<button type="button" aria-pressed="${reviewIntensity === 'low'}">低 · 轻量巩固</button>`);
    expect(html).toContain(`<button type="button" aria-pressed="${reviewIntensity === 'high'}">高 · 持续巩固</button>`);
    expect(html).toContain(reviewIntensity === 'low' ? '连续两次在不同日期答对' : '持续安排间隔复习');
  });
});
