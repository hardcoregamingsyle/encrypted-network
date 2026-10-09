import { useState } from 'react';
import MyDocuments from '../components/vault/MyDocuments.jsx';
import PublicDocuments from '../components/vault/PublicDocuments.jsx';
import PublishForm from '../components/vault/PublishForm.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useIdentity } from '../lib/identity.jsx';
import '../styles/vault.css';

// Route '/'. Lock and publish a file, see your documents, browse the public list.
export default function VaultPage() {
  const { status, identity, registration, register } = useIdentity();
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <div className="ui-container vault-page">
      <PageHeader
        title="Vault"
        lead="Lock a file in your browser, sign it with your key, and let anyone check that the version they hold is the latest and unchanged."
      />
      <div className="vault-layout">
        <div className="vault-col vault-col--main">
          <PublishForm
            status={status}
            identity={identity}
            registration={registration}
            onRegister={() => register(identity)}
            onPublished={() => setReloadKey((n) => n + 1)}
          />
        </div>
        <div className="vault-col vault-col--side">
          <MyDocuments status={status} identity={identity} reloadKey={reloadKey} />
          <PublicDocuments reloadKey={reloadKey} />
        </div>
      </div>
    </div>
  );
}
