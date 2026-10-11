import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { AuthPromptProvider } from './components/AuthPrompt.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import Layout from './components/Layout.jsx';
import Spinner from './components/Spinner.jsx';
import { ToastProvider } from './components/Toast.jsx';
import { SessionProvider, useSession } from './lib/session.jsx';
import AboutPage from './pages/AboutPage.jsx';
import AdvancedPage from './pages/AdvancedPage.jsx';
import ChatRoomPage from './pages/ChatRoomPage.jsx';
import ChatsPage from './pages/ChatsPage.jsx';
import DocumentPage from './pages/DocumentPage.jsx';
import FilesPage from './pages/FilesPage.jsx';
import MePage from './pages/MePage.jsx';
import NotFound from './pages/NotFound.jsx';
import SignInPage from './pages/SignInPage.jsx';
import VerifyPage from './pages/VerifyPage.jsx';
import WelcomePage from './pages/WelcomePage.jsx';

// "/" sends signed in people to their chats and everybody else to the welcome screen.
function RootRedirect() {
  const { status } = useSession();
  if (status === 'loading') {
    return (
      <div className="ui-splash">
        <h1 className="ui-sr-only">hrdlock</h1>
        <Spinner label="Opening hrdlock" size="lg" />
      </div>
    );
  }
  if (status === 'ready') return <Navigate to="/chats" replace />;
  if (status === 'needsKey') return <Navigate to="/signin" replace />;
  return <Navigate to="/welcome" replace />;
}

// Old /chat/:id links keep working.
function OldChatRoom() {
  const { channelId } = useParams();
  return <Navigate to={'/chats/' + encodeURIComponent(channelId || '')} replace />;
}

// The route table, in one place. Tests read it, so every path of the app is written down here.
// Old /chat paths and /keys are redirects, kept so old links still work.
const ROUTES = [
  { path: '/', element: <RootRedirect /> },
  { path: '/welcome', element: <WelcomePage /> },
  { path: '/signin', element: <SignInPage /> },
  { path: '/chats', element: <ChatsPage /> },
  { path: '/chats/:channelId', element: <ChatRoomPage /> },
  { path: '/chat', element: <Navigate to="/chats" replace /> },
  { path: '/chat/:channelId', element: <OldChatRoom /> },
  { path: '/files', element: <FilesPage /> },
  { path: '/d/:docId', element: <DocumentPage /> },
  { path: '/verify', element: <VerifyPage /> },
  { path: '/me', element: <MePage /> },
  { path: '/me/advanced', element: <AdvancedPage /> },
  { path: '/keys', element: <Navigate to="/me/advanced" replace /> },
  { path: '/about', element: <AboutPage /> },
  { path: '*', element: <NotFound /> }
];

export const ROUTE_PATHS = Object.freeze(ROUTES.map((route) => route.path));

function RoutedPages() {
  const location = useLocation();
  return (
    <ErrorBoundary resetKey={location.pathname}>
      <Routes>
        {ROUTES.map((route) => (
          <Route key={route.path} path={route.path} element={route.element} />
        ))}
      </Routes>
    </ErrorBoundary>
  );
}

// The router (BrowserRouter) is added in main.jsx so tests can use a memory router.
export default function App() {
  return (
    <ErrorBoundary>
      <SessionProvider>
        <ToastProvider>
          <AuthPromptProvider>
            <Layout>
              <RoutedPages />
            </Layout>
          </AuthPromptProvider>
        </ToastProvider>
      </SessionProvider>
    </ErrorBoundary>
  );
}

export { App };
