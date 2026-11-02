import { describe, expect, it } from 'vitest';
import { parseRoute, routeHash } from '../../src/web/router';

/** 页面地址：每个页面可收藏、可刷新，回看页能在新标签页里还原要看的内容 */
describe('页面地址', () => {
  it('各页面的地址能原样解析回来', () => {
    const routes = [
      { name: 'home' },
      { name: 'today' },
      { name: 'history' },
      { name: 'history', topicId: '主题 / A&B' },
      { name: 'learn' },
      { name: 'map' },
      { name: 'map', pointId: 'p1' },
      { name: 'topic', topicId: 't1' },
      { name: 'topic-draft', draftId: 'draft-1' },
      { name: 'library' },
      { name: 'library', cheatsheetId: 'c1' },
      { name: 'settings' },
      { name: 'personalization', tab: 'learning' },
      { name: 'personalization', tab: 'prompts' },
      { name: 'review', day: '2026-10-20' },
      { name: 'review', day: '2026-10-20', topicId: 'b8b65dc1-25c2-4f9e-be15-ef96f024e20d' },
    ] as const;
    for (const route of routes) {
      const parsed = parseRoute(routeHash(route));
      expect(Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined))).toEqual(route);
    }
  });

  it('首页和今天有独立地址，刷新时各自恢复', () => {
    expect(routeHash({ name: 'home' })).toBe('#/');
    expect(routeHash({ name: 'today' })).toBe('#/today');
    expect(parseRoute('#/')).toEqual({ name: 'home' });
    expect(parseRoute('#/today')).toEqual({ name: 'today' });
  });

  it('不认识的地址、格式不对的日期回到首页', () => {
    for (const hash of ['', '#', '#/nope', '#/review', '#/review/20261020', '#/topics', '#/topic-drafts']) {
      expect(parseRoute(hash)).toEqual({ name: 'home' });
    }
  });

  it('历史课程可以直接打开，筛选主题在刷新后保留', () => {
    expect(routeHash({ name: 'history' })).toBe('#/history');
    expect(parseRoute('#/history')).toEqual({ name: 'history', topicId: undefined });
    expect(parseRoute('#/history?topic=topic-1')).toEqual({ name: 'history', topicId: 'topic-1' });
    expect(parseRoute('#/history?topic=')).toEqual({ name: 'history', topicId: undefined });
  });

  it('个性化的两个标签有独立地址，刷新后保持当前分类', () => {
    expect(routeHash({ name: 'personalization', tab: 'learning' })).toBe('#/personalization');
    expect(routeHash({ name: 'personalization', tab: 'prompts' })).toBe('#/personalization/prompts');
    expect(parseRoute('#/personalization')).toEqual({ name: 'personalization', tab: 'learning' });
    expect(parseRoute('#/personalization/prompts')).toEqual({ name: 'personalization', tab: 'prompts' });
    expect(parseRoute('#/personalization/unknown')).toEqual({ name: 'personalization', tab: 'learning' });
  });
});
