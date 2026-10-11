import { Link } from 'react-router-dom';
import Icon from '../Icon.jsx';
import { isDocId } from '../../../shared/records.js';

// A small card at the top of a room whose chat is about a file. The id comes from the server and is
// not signature checked, so it is only used when it looks like a file id. The file page checks the
// file itself.
export default function LinkedFileCard({ docId }) {
  const id = typeof docId === 'string' ? docId : '';
  if (!isDocId(id)) return null;
  return (
    <Link className="chat-filecard" to={`/d/${id}`}>
      <span className="chat-filecard__icon">
        <Icon name="file" size={22} />
      </span>
      <span className="chat-filecard__text">
        <span className="chat-filecard__title">This chat is about a file</span>
        <span className="chat-filecard__sub">Open the file page to see its versions and check it</span>
      </span>
      <Icon name="chevron-right" size={20} />
    </Link>
  );
}
