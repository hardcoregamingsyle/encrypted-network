import { useEffect } from 'react';

export const SITE_NAME = 'hrdlock';

// Sets the browser tab title. Pages can call it too.
export function usePageTitle(title) {
  useEffect(() => {
    if (typeof document === 'undefined' || !title) return;
    document.title = `${title} - ${SITE_NAME}`;
  }, [title]);
}

// The page h1 with an optional lead sentence and action buttons. It also sets document.title.
export default function PageHeader({ title, lead, actions, documentTitle }) {
  usePageTitle(documentTitle || (typeof title === 'string' ? title : ''));
  return (
    <header className="ui-page-header">
      <div className="ui-page-header__text">
        <h1 className="ui-page-header__title">{title}</h1>
        {lead ? <p className="ui-page-header__lead">{lead}</p> : null}
      </div>
      {actions ? <div className="ui-page-header__actions">{actions}</div> : null}
    </header>
  );
}

export { PageHeader };
