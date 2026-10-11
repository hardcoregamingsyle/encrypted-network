import { Link } from 'react-router-dom';
import EmptyState from '../components/EmptyState.jsx';
import ScreenHeader from '../components/ScreenHeader.jsx';

export default function NotFound() {
  return (
    <div className="ui-screen">
      <ScreenHeader title="Page not found" />
      <div className="ui-container ui-container--narrow">
        <EmptyState title="There is nothing at this address" art="search">
          <p>
            Check the address, or go back to your <Link to="/chats">chats</Link>. If you were given a link to a file, ask
            the sender for the full link.
          </p>
        </EmptyState>
      </div>
    </div>
  );
}
