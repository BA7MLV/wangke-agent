import { useEffect, useState } from 'react';
import type { ProjectDto } from '@wangke/contracts';
import { serverClient } from '../api/serverClient';
import { cloud } from '../cloud/state';
import { projectError } from './errors';

export function useProjectLibrary() {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!cloud.enabled) return;
    let ignore = false;
    setError('');
    serverClient.projects().then(result => { if (!ignore) setProjects(result.projects.filter(p => !p.archived)); })
      .catch(error => { if (!ignore) setError(projectError(error)); });
    return () => { ignore = true; };
  }, [revision]);
  return { projects, error, retry: () => setRevision(v => v + 1) };
}
