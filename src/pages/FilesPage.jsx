import { useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useSignInPrompt } from '../components/AuthPrompt.jsx';
import Button from '../components/Button.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Fab from '../components/Fab.jsx';
import ScreenHeader from '../components/ScreenHeader.jsx';
import Skeleton from '../components/Skeleton.jsx';
import AddFileSheet from '../components/files/AddFileSheet.jsx';
import FileList from '../components/files/FileList.jsx';
import PrivateFiles from '../components/files/PrivateFiles.jsx';
import { TABS, emptyCopy, listSummary, publicRow, tabFromSearch, usableRows } from '../components/files/filesLogic.js';
import useFileList, { useDebounced } from '../components/files/useFileList.js';
import useMineFiles from '../components/files/useMineFiles.js';
import { PAGE_SIZE, SEARCH_DELAY_MS, SEARCH_MAX, normalizeQuery } from '../components/vault/vaultLogic.js';
import { NEEDS_KEY_COPY, needsKeyKind } from '../lib/authText.js';
import { useSession } from '../lib/session.jsx';
import '../styles/files.css';

// The Mine / Public switch. Two buttons, the pressed one is the list on screen.
export function TabSwitch({ tab, onChange }) {
  return (
    <div className="files-seg" role="group" aria-label="Which files to show">
      {TABS.map((t) => (
        <button key={t.id} type="button" className={`files-seg__btn ${tab === t.id ? 'is-on' : ''}`.trim()} aria-pressed={tab === t.id} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

function MineTab({ session, reloadKey, onAdd, now }) {
  const prompt = useSignInPrompt();
  const ready = session.status === 'ready' && Boolean(session.identity);
  const mine = useMineFiles({ ready, mode: session.mode, keyId: session.identity ? session.identity.keyId : '', reloadKey });

  if (session.status === 'loading') return <Skeleton variant="row" count={4} label="Loading your files" />;
  if (session.status === 'needsKey') {
    const copy = NEEDS_KEY_COPY[needsKeyKind(session)];
    return (
      <EmptyState art="files" title="One more step" action={<Link className="ui-btn ui-btn--primary" to="/signin"><span className="ui-btn__label">{copy.action}</span></Link>}>
        {copy.files}
      </EmptyState>
    );
  }
  if (!ready) {
    return (
      <EmptyState art="files" title="Sign in to see your files" action={<Button variant="primary" onClick={() => prompt.open('to see your files')}>Sign in</Button>}>
        Anyone can open a file link or look at the Public list without signing in.
      </EmptyState>
    );
  }
  const empty = emptyCopy('mine');
  return (
    <FileList
      list={mine.list}
      rows={mine.rows}
      empty={empty}
      action={<Button variant="primary" onClick={onAdd}>Add file</Button>}
      onForget={mine.forget}
      busyLabel="Loading your files"
      errorTitle="Could not load your files"
      now={now}
    />
  );
}

function PublicTab({ reloadKey, now }) {
  const inputId = useId();
  const [text, setText] = useState('');
  const q = useDebounced(normalizeQuery(text), SEARCH_DELAY_MS);
  const list = useFileList({ q, limit: PAGE_SIZE, reloadKey });
  const rows = usableRows(list.items.map(publicRow));
  const searching = q !== '';
  const typing = normalizeQuery(text) !== q;
  const summary = list.status === 'ready' && !typing ? listSummary(rows.length, { searching }) : list.status === 'loading' ? 'Searching' : '';

  return (
    <>
      <form className="files-search" role="search" onSubmit={(e) => e.preventDefault()}>
        <label className="ui-sr-only" htmlFor={inputId}>
          Search public files by label
        </label>
        <input id={inputId} type="search" value={text} maxLength={SEARCH_MAX} placeholder="Search public files" autoComplete="off" onChange={(e) => setText(e.target.value)} />
      </form>
      <p className="ui-sr-only" role="status" aria-live="polite">
        {summary}
      </p>
      <FileList
        list={list}
        rows={rows}
        showOwner
        empty={emptyCopy('public', { searching })}
        busyLabel="Loading public files"
        errorTitle="Could not load the public files"
        now={now}
      />
    </>
  );
}

// Route /files. Mine and Public lists, and the + button that opens the Add file sheet.
export default function FilesPage() {
  const session = useSession();
  const prompt = useSignInPrompt();
  const [params, setParams] = useSearchParams();
  const tab = tabFromSearch(params.get('tab'));
  const [adding, setAdding] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [now] = useState(() => Date.now());
  const ready = session.status === 'ready' && Boolean(session.identity);

  function changeTab(next) {
    setParams(next === 'mine' ? {} : { tab: next }, { replace: true });
  }

  function openAdd() {
    if (ready) setAdding(true);
    else prompt.open('to add a file');
  }

  return (
    <div className="ui-screen files-page">
      <ScreenHeader title="Files" subtitle={{ public: 'Files anyone can find', private: 'Files only you can open' }[tab] || 'Files you published'} />
      <div className="ui-container ui-container--narrow files-body">
        <TabSwitch tab={tab} onChange={changeTab} />
        {tab === 'public' ? <PublicTab reloadKey={reloadKey} now={now} /> : tab === 'private' ? <PrivateFiles session={session} /> : <MineTab session={session} reloadKey={reloadKey} onAdd={openAdd} now={now} />}
      </div>
      {tab !== 'private' ? <Fab label="Add file" onClick={openAdd} /> : null}
      <AddFileSheet
        open={adding}
        onClose={() => setAdding(false)}
        onPublished={() => {
          setReloadKey((n) => n + 1);
          changeTab('mine');
        }}
      />
    </div>
  );
}
