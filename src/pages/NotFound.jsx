import { Link } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';

export default function NotFound() {
  return (
    <div className="ui-container ui-container--narrow">
      <PageHeader title="Page not found" lead="There is nothing at this address." documentTitle="Page not found" />
      <p>
        Check the address, or go back to the <Link to="/">vault</Link>. If you were given a link to a document, ask
        the sender for the full link.
      </p>
    </div>
  );
}
