import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { AuthProvider } from './features/auth/AuthProvider';
import { AttendanceProvider } from './features/attendance/AttendanceProvider.tsx';
import { LoginPage } from './pages/LoginPage';
import { ConsentPage } from './pages/ConsentPage';
import { DeviceBlockedPage } from './pages/DeviceBlockedPage';
import { OfflineLockedPage } from './pages/OfflineLockedPage';
import { HomePage } from './pages/HomePage';
import CheckInPage from './pages/CheckInPage';
import CheckOutPage from './pages/CheckOutPage';
import { ClientListScreen } from './features/clients/ClientListScreen.tsx';
import { VisitCaptureFlow } from './features/visits/VisitCaptureFlow.tsx';
import './index.css';

const queryClient = new QueryClient();

const router = createBrowserRouter([
  {
    element: <App />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/check-in', element: <CheckInPage /> },
      { path: '/check-out', element: <CheckOutPage /> },
      { path: '/visit', element: <ClientListScreen /> },
      { path: '/visit/:clientId', element: <VisitCaptureFlow /> },
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
        <AttendanceProvider>
          <RouterProvider router={router} />
        </AttendanceProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
