import { useEffect, useState } from 'react';

/**
 * 页面地址（hash 路由，静态部署也能用）：
 * #/ 首页 · #/today 今天 · #/history?topic=主题 历史课程 · #/learn 学习中的一节 · #/map 认知地图（#/map/知识点） · #/topics/主题 · #/library 速查表与导出
 * （#/library/速查表） · #/topic-drafts/讨论 主题澄清 · #/settings 设置 · #/personalization 个性化
 * （#/personalization/prompts 个性化提示词） · #/review/日期?topic=主题 按天回看
 */
export type PersonalizationTab = 'learning' | 'prompts';

export type Route =
  | { name: 'home' }
  | { name: 'today' }
  | { name: 'history'; topicId?: string }
  | { name: 'learn' }
  | { name: 'map'; pointId?: string }
  | { name: 'topic'; topicId: string }
  | { name: 'topic-draft'; draftId: string }
  | { name: 'library'; cheatsheetId?: string }
  | { name: 'settings' }
  | { name: 'personalization'; tab: PersonalizationTab }
  | { name: 'review'; day: string; topicId?: string };

export function parseRoute(hash: string): Route {
  const [path = '', search = ''] = hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(search);
  switch (parts[0]) {
    case 'today':
      return { name: 'today' };
    case 'history':
      return { name: 'history', topicId: params.get('topic') || undefined };
    case 'learn':
      return { name: 'learn' };
    case 'map':
      return { name: 'map', pointId: parts[1] };
    case 'topics':
      return parts[1] ? { name: 'topic', topicId: parts[1] } : { name: 'home' };
    case 'topic-drafts':
      return parts[1] ? { name: 'topic-draft', draftId: parts[1] } : { name: 'home' };
    case 'library':
      return { name: 'library', cheatsheetId: parts[1] };
    case 'settings':
      return { name: 'settings' };
    case 'personalization':
      return { name: 'personalization', tab: parts[1] === 'prompts' ? 'prompts' : 'learning' };
    case 'review':
      return parts[1] && /^\d{4}-\d{2}-\d{2}$/.test(parts[1])
        ? { name: 'review', day: parts[1], topicId: params.get('topic') ?? undefined }
        : { name: 'home' };
    default:
      return { name: 'home' };
  }
}

export function routeHash(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/';
    case 'today':
      return '#/today';
    case 'history':
      return `#/history${route.topicId ? `?topic=${encodeURIComponent(route.topicId)}` : ''}`;
    case 'learn':
      return '#/learn';
    case 'map':
      return route.pointId ? `#/map/${encodeURIComponent(route.pointId)}` : '#/map';
    case 'topic':
      return `#/topics/${encodeURIComponent(route.topicId)}`;
    case 'topic-draft':
      return `#/topic-drafts/${encodeURIComponent(route.draftId)}`;
    case 'library':
      return route.cheatsheetId ? `#/library/${encodeURIComponent(route.cheatsheetId)}` : '#/library';
    case 'settings':
      return '#/settings';
    case 'personalization':
      return route.tab === 'prompts' ? '#/personalization/prompts' : '#/personalization';
    case 'review':
      return `#/review/${route.day}${route.topicId ? `?topic=${encodeURIComponent(route.topicId)}` : ''}`;
  }
}

export function navigate(route: Route): void {
  window.location.hash = routeHash(route);
}

/** 在新标签页打开按天回看，不打断当前页面 */
export function openReview(day: string, topicId?: string): void {
  window.open(routeHash({ name: 'review', day, topicId }), '_blank');
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseRoute(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
