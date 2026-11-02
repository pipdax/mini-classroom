import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewDay } from '../../src/web/api';
import { useResource } from '../../src/web/hooks';
import { HistoryScreen } from '../../src/web/screens/HistoryScreen';

vi.mock('../../src/web/hooks', () => ({ useResource: vi.fn() }));

const days: ReviewDay[] = [
  { day: '2026-11-02', pointCount: 3 },
  { day: '2026-11-01', pointCount: 1 },
  { day: '2026-10-31', pointCount: 2 },
  { day: '2026-10-30', pointCount: 2 },
  { day: '2026-10-29', pointCount: 4 },
  { day: '2026-10-28', pointCount: 1 },
  { day: '2025-11-02', pointCount: 5 },
];

function render(topicId?: string, topicsError = '') {
  return renderToStaticMarkup(createElement(HistoryScreen, {
    topicId, topics: [], topicsError, onTopicsChanged: () => {},
  }));
}

/** 历史入口应能找到较早的内容，筛选后回看同一主题，并区分没有记录和读取失败。 */
describe('历史课程', () => {
  beforeEach(() => {
    vi.mocked(useResource).mockReturnValue({ data: days, loading: false, error: '', reload: vi.fn() });
  });

  it('全部学习日期均可回看，跨年的同月同日不会混淆', () => {
    const html = render();
    for (const day of days) expect(html).toContain(`href="#/review/${day.day}"`);
    expect(html.match(/查看课程/g)).toHaveLength(days.length);
    expect(html.indexOf('2026年11月2日')).toBeLessThan(html.indexOf('2025年11月2日'));
    expect(html).toContain('学过 3 个知识点');
    expect(html).toContain('7 天');
  });

  it('回看链接保留当前主题，特殊字符不会改变筛选含义', () => {
    const html = render('主题 / A&B');
    expect(html).toContain(`href="#/review/2026-11-02?topic=${encodeURIComponent('主题 / A&B')}"`);
    expect(html).not.toContain('href="#/review/2026-11-02"');
  });

  it('没有记录时说明记录何时出现，并提供继续学习入口', () => {
    vi.mocked(useResource).mockReturnValue({ data: [], loading: false, error: '', reload: vi.fn() });
    expect(render()).toContain('还没有历史课程');
    expect(render()).toContain('完成作答后');
    expect(render()).toContain('href="#/today"');
    expect(render('topic-1')).toContain('这个主题还没有学习记录');
  });

  it('重新读取时隐藏旧结果，失败时显示重试而不是空记录', () => {
    vi.mocked(useResource).mockReturnValue({ data: days, loading: true, error: '', reload: vi.fn() });
    expect(render()).toContain('正在读取历史课程');
    expect(render()).not.toContain('href="#/review/');
    vi.mocked(useResource).mockReturnValue({ data: days, loading: false, error: '网络断开', reload: vi.fn() });
    const failed = render();
    expect(failed).toContain('网络断开');
    expect(failed).toContain('重新加载');
    expect(failed).not.toContain('还没有历史课程');
    expect(failed).not.toContain('href="#/review/');
  });

  it('主题列表读取失败时仍可回看已加载的日期，并提供主题重试入口', () => {
    const html = render(undefined, '服务暂时不可用');
    expect(html).toContain('href="#/review/2026-11-02"');
    expect(html).toContain('重新加载主题');
    expect(html).toMatch(/<select[^>]*disabled=""/);
  });
});
