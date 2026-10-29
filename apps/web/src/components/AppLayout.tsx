import { Suspense, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { NavigationShell, PageShell } from '../ui/layout';
import { useCourseChat } from '../store/courseChat';
import { useAppNav } from './appNav';
import { useRecentChats } from './useRecentChats';
import { SettingsButton } from './SettingsModal';

/** 只让 Outlet 内的页面切换；导航和最近会话的查询始终保持同一份。 */
export default function AppLayout() {
  const { pathname } = useLocation();
  const nav = useAppNav();
  const chatPage = ['/', '/chat', '/course-chat'].includes(pathname) || pathname.startsWith('/settings');
  const recent = useRecentChats(chatPage);
  const bootstrap = useCourseChat((s) => s.bootstrap);
  useEffect(() => { void bootstrap(); }, [bootstrap]);

  return (
    <NavigationShell rail={nav} recent={recent} railFooter={<SettingsButton variant="rail" testId="nav-rail-settings" />}>
      <Suspense fallback={<PageShell title={pathname.startsWith('/library') ? '资源' : ''} fill>
        <div className="route-fallback" aria-label="正在加载页面" aria-busy="true" />
      </PageShell>}>
        <Outlet />
      </Suspense>
    </NavigationShell>
  );
}
