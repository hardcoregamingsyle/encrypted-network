import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import ChannelList from '../components/chat/ChannelList.jsx';
import ChannelView from '../components/chat/ChannelView.jsx';
import CreateChannelForm from '../components/chat/CreateChannelForm.jsx';
import EmptyState from '../components/EmptyState.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { isChannelId } from '../../shared/records.js';
import '../styles/chat.css';

// Routes: /chat (channel list and create form) and /chat/:channelId (one channel).
export default function ChatPage() {
  const { channelId } = useParams();
  const [reloadKey, setReloadKey] = useState(0);

  if (channelId !== undefined) {
    if (!isChannelId(channelId)) {
      return (
        <div className="ui-container">
          <PageHeader title="Channel not found" lead="That is not a valid channel id." />
          <EmptyState title="Channel ids have 3 to 40 lowercase letters, digits or hyphens">
            <Link to="/chat">Back to the channels</Link>
          </EmptyState>
        </div>
      );
    }
    return <ChannelView key={channelId} channelId={channelId} />;
  }

  return (
    <div className="ui-container">
      <PageHeader
        title="Chat"
        lead="Open channels where every message is signed by its writer and checked in your browser. Anyone can read, you need an identity to write."
      />
      <div className="chat-home">
        <ChannelList reloadKey={reloadKey} />
        <CreateChannelForm onCreated={() => setReloadKey((n) => n + 1)} />
      </div>
    </div>
  );
}
