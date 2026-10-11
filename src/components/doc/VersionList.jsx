import Icon from '../Icon.jsx';

// The versions of a file, newest first. rows come from versionRows() in pageLogic.js.
// Each line reads like "Version 2, Priya, today 10:02". A withdrawn entry shows the owner's reason.
export default function VersionList({ rows }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return <p className="ui-muted">The server sent no versions for this file.</p>;
  }
  return (
    <ol className="doc-versions" aria-label="Versions">
      {rows.map((row) => (
        <li key={row.key} className={`doc-versions__item ${row.withdrawn ? 'is-withdrawn' : ''}`.trim()}>
          <span className="doc-versions__mark" aria-hidden="true">
            <Icon name={row.withdrawn ? 'x' : 'file'} size={18} />
          </span>
          <span className="doc-versions__text">
            <span className="doc-versions__line">
              {row.line}
              {row.isHead ? <span className="ui-badge ui-badge--info doc-versions__latest">Latest</span> : null}
            </span>
            {row.withdrawn ? (
              <span className="doc-versions__sub">Reason: {row.reason || 'none given'}</span>
            ) : row.label ? (
              <span className="doc-versions__sub">{row.label}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
