import { useState } from 'react';
import Fab from '../components/Fab.jsx';
import Icon from '../components/Icon.jsx';
import ScreenHeader from '../components/ScreenHeader.jsx';
import ChannelList from '../components/chat/ChannelList.jsx';
import NewChatSheet from '../components/chat/NewChatSheet.jsx';
import '../styles/chat.css';

// The chat list: search, one row per chat (avatar, name, last message, time, unread count) and a
// "New chat" button. Chats are public, so the list is open to people who are not signed in.
export default function ChatsPage() {
  const [query, setQuery] = useState('');
  const [sheet, setSheet] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <div className="ui-screen chat-home">
      <ScreenHeader title="Chats" subtitle="Public chats" />
      <div className="ui-container chat-home__body">
        <div className="chat-search">
          <label className="ui-sr-only" htmlFor="chat-search-input">
            Search chats
          </label>
          <span className="chat-search__icon">
            <Icon name="search" size={18} />
          </span>
          <input
            id="chat-search-input"
            className="chat-search__input"
            type="search"
            placeholder="Search chats"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <ChannelList query={query} reloadKey={reloadKey} onNewChat={() => setSheet(true)} />
        <p className="ui-muted chat-home__note">
          Anyone can read these chats. Names and previews here come from the server and are not checked. Each message is checked on your device when you open the chat.
        </p>
      </div>
      <Fab label="New chat" onClick={() => setSheet(true)} />
      <NewChatSheet open={sheet} onClose={() => setSheet(false)} onCreated={() => setReloadKey((n) => n + 1)} />
    </div>
  );
}
