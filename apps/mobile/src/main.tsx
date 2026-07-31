import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { AuthProvider } from './features/auth/AuthProvider';
import { LoginPage } from './pages/LoginPage';
import { ConsentPage } from './pages/ConsentPage';
import { DeviceBlockedPage } from './pages/DeviceBlockedPage';
import { OfflineLockedPage } from './pages/OfflineLockedPage';
import { HomePage } from './pages/HomePage';
import './index.css';

const queryClient = new QueryClient();

const router = createBrowserRouter([
  {
    element: <App />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/login', element: <LoginPage /> },
      { path: '/consent', element: <ConsentPage /> },
      { path: '/device-blocked', element: <DeviceBlockedPage /> },
      { path: '/locked', element: <OfflineLockedPage /> },
    ],
  },
]);

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
