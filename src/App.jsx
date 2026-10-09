import { Route, Routes, useLocation } from 'react-router-dom';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import Layout from './components/Layout.jsx';
import { ToastProvider } from './components/Toast.jsx';
import { IdentityProvider } from './lib/identity.jsx';
import AboutPage from './pages/AboutPage.jsx';
import ChatPage from './pages/ChatPage.jsx';
import DocumentPage from './pages/DocumentPage.jsx';
import KeysPage from './pages/KeysPage.jsx';
import NotFound from './pages/NotFound.jsx';
import VaultPage from './pages/VaultPage.jsx';
import VerifyPage from './pages/VerifyPage.jsx';

function RoutedPages() {
  const location = useLocation();
  return (
    <ErrorBoundary resetKey={location.pathname}>
      <Routes>
        <Route path="/" element={<VaultPage />} />
        <Route path="/keys" element={<KeysPage />} />
        <Route path="/d/:docId" element={<DocumentPage />} />
        <Route path="/verify" element={<VerifyPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:channelId" element={<ChatPage />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </ErrorBoundary>
  );
}

// The router (BrowserRouter) is added in main.jsx so tests can use a memory router.
export default function App() {
  return (
    <ErrorBoundary>
      <IdentityProvider>
        <ToastProvider>
          <Layout>
            <RoutedPages />
          </Layout>
        </ToastProvider>
      </IdentityProvider>
    </ErrorBoundary>
  );
}

export { App };
