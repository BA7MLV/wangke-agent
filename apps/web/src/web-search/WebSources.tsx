import { useTranslation } from 'react-i18next';
import { parseWebSearchResult, type WebSearchResult } from '@wangke/contracts/web-search';
import './web-search.css';

export default function WebSources({ result }: { result: WebSearchResult }) {
  const { t, i18n } = useTranslation('settings');
  const safe = parseWebSearchResult(JSON.stringify(result));
  if (!safe) return null;
  return <section className="web-sources" aria-label={t('webSearch.sources')} data-testid="web-sources">
    <div className="web-sources__header"><span>{t('webSearch.sourceCount', { count: safe.sources.length })}</span><span>{safe.provider}</span></div>
    <p className="web-sources__query">{safe.query}</p>
    {safe.sources.length ? <ol className="web-sources__list">{safe.sources.map((source, index) => <li key={source.url}>
      <a href={source.url} target="_blank" rel="noopener noreferrer" className="web-source">
        <span className="web-source__number" aria-hidden="true">{index + 1}</span>
        <span className="web-source__body">
          <span className="web-source__meta"><span>{new URL(source.url).hostname.replace(/^www\./, '')}</span>{source.published && Number.isFinite(Date.parse(source.published)) ? <time dateTime={source.published}>{new Date(source.published).toLocaleDateString(i18n.language)}</time> : null}</span>
          <span className="web-source__title">{source.title}<span aria-hidden="true"> ↗</span></span>
          {source.snippet ? <span className="web-source__snippet">{source.snippet}</span> : null}
        </span>
      </a>
    </li>)}</ol> : <p className="web-sources__empty">{t('webSearch.empty')}</p>}
  </section>;
}
