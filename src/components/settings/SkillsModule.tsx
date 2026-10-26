import { lazy, Suspense, useState } from 'react';
import { Button, Spinner } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import SkillsCard from '../SkillsCard';
const McpSettings = lazy(() => import('../../mcp/McpSettings'));

/** 「技能」模块：管理会注入讲义生成与课程问答的技能。 */
export default function SkillsModule() {
  const [tab, setTab] = useState<'skills' | 'mcp'>('skills');
  const { t } = useTranslation('settings');
  return <div className="flex flex-col gap-4">
    <div className="flex gap-2" role="group" aria-label={t('modules.skills')}>
      <Button variant={tab === 'skills' ? 'primary' : 'tertiary'} aria-pressed={tab === 'skills'} onPress={() => setTab('skills')}>{t('mcp.skills')}</Button>
      <Button variant={tab === 'mcp' ? 'primary' : 'tertiary'} aria-pressed={tab === 'mcp'} onPress={() => setTab('mcp')}>MCP</Button>
    </div>
    {tab === 'skills' ? <SkillsCard /> : <Suspense fallback={<Spinner />}><McpSettings /></Suspense>}
  </div>;
}
