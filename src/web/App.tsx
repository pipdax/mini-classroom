import { useEffect, useState } from 'react';
import { type Session, type Topic, api, devNow } from './api';
import { Icon, type IconName, Mark } from './components/Icon';
import { useResource } from './hooks';
import { useReminders } from './reminders';
import { type Route, navigate, routeHash, useRoute } from './router';
import { DayReviewPage } from './screens/DayReviewPage';
import { HomeScreen } from './screens/HomeScreen';
import { HistoryScreen } from './screens/HistoryScreen';
import { LearnScreen } from './screens/LearnScreen';
import { LibraryScreen } from './screens/LibraryScreen';
import { MapScreen } from './screens/MapScreen';
import { PersonalizationScreen } from './screens/PersonalizationScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { TodayScreen } from './screens/TodayScreen';
import { TopicScreen } from './screens/TopicScreen';
import { TopicPlanningScreen } from './screens/TopicPlanningScreen';
import './styles.css';

const NAV: { route: Route; label: string; icon: IconName }[] = [
  { route: { name: 'home' }, label: '首页', icon: 'home' },
  { route: { name: 'today' }, label: '今天', icon: 'today' },
  { route: { name: 'history' }, label: '历史课程', icon: 'history' },
  { route: { name: 'map' }, label: '认知地图', icon: 'map' },
  { route: { name: 'library' }, label: '速查表与导出', icon: 'library' },
];

const PREFERENCES_NAV: { route: Route; label: string; icon: IconName }[] = [
  { route: { name: 'personalization', tab: 'learning' }, label: '个性化', icon: 'personalize' },
  { route: { name: 'settings' }, label: '设置', icon: 'settings' },
];

const TITLES: Record<Route['name'], string> = {
  home: '首页',
  today: '今天',
  history: '历史课程',
  learn: '微课堂',
  map: '认知地图',
  topic: '学习主题',
  'topic-draft': '明确学习目标',
  library: '速查表与导出',
  settings: '设置',
  personalization: '个性化',
  review: '按天回看',
};

export function App() {
  const route = useRoute();
  const [devMode, setDevMode] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // 开始的一节放在内存里；刷新学习页时由服务端恢复未完成的一节
  const [session, setSession] = useState<{ session: Session; notice?: string } | null>(null);
  const topics = useResource(() => api.listTopics().then((r) => r.topics), [route.name]);
  useReminders();

  useEffect(() => {
    api.health().then((h) => setDevMode(h.devMode), () => setDevMode(false));
  }, []);
  useEffect(() => setMenuOpen(false), [route]);

  // 回看页独立展示完整内容，没有侧栏
  if (route.name === 'review') return <DayReviewPage day={route.day} topicId={route.topicId} />;

  const startSession = (next: Session, notice?: string) => {
    setSession({ session: next, notice });
    navigate({ name: 'learn' });
  };

  return (
    <div className="app">
      <nav className={`sidebar ${menuOpen ? 'open' : ''}`} aria-label="主导航">
        <div className="brand">
          <a className="brand-home" href={routeHash({ name: 'home' })} aria-label="微课堂首页" onClick={() => setMenuOpen(false)}>
            <Mark />
            <span>微课堂</span>
          </a>
          <button type="button" className="icon-btn close-menu" style={{ marginLeft: 'auto' }} aria-label="关闭菜单" onClick={() => setMenuOpen(false)}>
            <Icon name="close" />
          </button>
        </div>
        <div className="sidebar-scroll">
          {NAV.map((item) => (
            <a key={item.label} className="nav-item" href={routeHash(item.route)} aria-current={isCurrent(route, item.route) ? 'page' : undefined} onClick={() => setMenuOpen(false)}>
              <Icon name={item.icon} />
              {item.label}
            </a>
          ))}
          <TopicNav topics={topics.data ?? []} route={route} />
        </div>
        <div className="sidebar-bottom">
          {devMode && <DevClock />}
          <div className="sidebar-preferences" role="group" aria-label="设置与个性化">
            {PREFERENCES_NAV.map((item) => (
              <a key={item.label} className="nav-item" href={routeHash(item.route)} aria-current={isCurrent(route, item.route) ? 'page' : undefined}>
                <Icon name={item.icon} />
                {item.label}
              </a>
            ))}
          </div>
        </div>
      </nav>
      <div className="sheet">
        <header className="topbar">
          <button type="button" className="icon-btn" aria-label="打开菜单" onClick={() => setMenuOpen(true)}>
            <Icon name="menu" />
          </button>
          <span className="t-title">{TITLES[route.name]}</span>
          <Mark />
          <span style={{ width: 8 }} />
        </header>
        <main className="canvas">
          {route.name === 'home' && <HomeScreen topics={topics.data} topicsError={topics.error} onTopicsChanged={topics.reload} onStart={startSession} />}
          {route.name === 'today' && <TodayScreen topics={topics.data} onTopicsChanged={topics.reload} onStart={startSession} />}
          {route.name === 'history' && <HistoryScreen key={route.topicId ?? 'all'} topicId={route.topicId} topics={topics.data} topicsError={topics.error} onTopicsChanged={topics.reload} />}
          {route.name === 'learn' && <LearnScreen initial={session} onDone={() => setSession(null)} />}
          {route.name === 'map' && <MapScreen pointId={route.pointId} />}
          {route.name === 'topic' && <TopicScreen key={route.topicId} topicId={route.topicId} onTopicsChanged={topics.reload} />}
          {route.name === 'topic-draft' && <TopicPlanningScreen key={route.draftId} draftId={route.draftId} onTopicsChanged={topics.reload} />}
          {route.name === 'library' && <LibraryScreen cheatsheetId={route.cheatsheetId} />}
          {route.name === 'settings' && <SettingsScreen />}
          {route.name === 'personalization' && <PersonalizationScreen tab={route.tab} />}
        </main>
      </div>
    </div>
  );
}

function isCurrent(route: Route, target: Route): boolean {
  if (target.name === 'today') return route.name === 'today' || route.name === 'learn';
  return route.name === target.name;
}

const PLACEMENT_STATE: Record<string, string> = { pending: '待摸底', preparing: '准备摸底', testing: '摸底中' };

/** 侧栏里的学习主题：每个主题是一个页面 */
function TopicNav({ topics, route }: { topics: Topic[]; route: Route }) {
  if (topics.length === 0) return null;
  const stateOf = (t: Topic) => {
    if (t.graphStatus === 'pending') return '生成中';
    if (t.graphStatus === 'failed') return '生成失败';
    if (t.status === 'paused') return '暂停';
    return PLACEMENT_STATE[t.placementStatus] ?? '';
  };
  return (
    <>
      <div className="group-label">学习主题</div>
      {topics.map((t) => (
        <a
          key={t.id}
          className="nav-item"
          href={routeHash({ name: 'topic', topicId: t.id })}
          aria-current={route.name === 'topic' && route.topicId === t.id ? 'page' : undefined}
        >
          <Icon name="topic" />
          <span className="topic-name">{t.title}</span>
          <span className="count">{stateOf(t)}</span>
        </a>
      ))}
    </>
  );
}

/** 开发模式：模拟当前时间，用于验收"第二天"的复习安排 */
function DevClock() {
  const [value, setValue] = useState(devNow.get());
  return (
    <div className="field" style={{ padding: '0 8px' }}>
      <label className="small muted" htmlFor="dev-now">
        模拟时间（开发模式）
      </label>
      <input
        id="dev-now"
        className="input"
        type="datetime-local"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          devNow.set(e.target.value);
        }}
      />
      {value && (
        <button
          type="button"
          className="btn small"
          onClick={() => {
            setValue('');
            devNow.set('');
          }}
        >
          恢复真实时间
        </button>
      )}
    </div>
  );
}
