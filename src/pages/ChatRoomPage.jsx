import { Link, useParams } from 'react-router-dom';
import EmptyState from '../components/EmptyState.jsx';
import ScreenHeader from '../components/ScreenHeader.jsx';
import ChannelView from '../components/chat/ChannelView.jsx';
import { isChannelId } from '../../shared/records.js';
import '../styles/chat.css';

// One chat room at /chats/:channelId. The id from the address is checked before anything is asked
// of the server.
export default function ChatRoomPage() {
  const { channelId } = useParams();
  if (!isChannelId(channelId)) {
    return (
      <div className="ui-screen">
        <ScreenHeader title="Chat not found" back="/chats" backLabel="Back to chats" />
        <div className="ui-container">
          <EmptyState art="search" title="That is not a chat address" action={<Link className="ui-btn ui-btn--primary" to="/chats">Back to chats</Link>}>
            A chat address has 3 to 40 lowercase letters, digits or hyphens.
          </EmptyState>
        </div>
      </div>
    );
  }
  return <ChannelView key={channelId} channelId={channelId} />;
}
