/**
 * HKUMySeat, the student app.
 *
 * hkumyseat.com is a gateway: the server sends you to /login/ or /dashboard/
 * depending on whether you are signed in, so the bare domain stays free for
 * whatever the site needs later. Everything a signed-in student uses lives
 * under /dashboard/.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import Login from './pages/Login.tsx';
import Signup from './pages/Signup.tsx';
import Dashboard from './pages/Dashboard.tsx';
import Spaces from './pages/Spaces.tsx';
import './tokens.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('no #root');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/login/" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/signup/" element={<Signup />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/dashboard/" element={<Dashboard />} />
        <Route path="/dashboard/spaces" element={<Spaces />} />
        <Route path="/dashboard/spaces/" element={<Spaces />} />
        <Route path="/dashboard/spaces/:floorId" element={<Spaces />} />
        {/* The shapes the first version used; old links keep working. */}
        <Route path="/search" element={<Navigate to="/dashboard/" replace />} />
        <Route path="/spaces" element={<Navigate to="/dashboard/spaces/" replace />} />
        <Route path="/spaces/:floorId" element={<LegacySpace />} />
        <Route path="*" element={<Navigate to="/dashboard/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);

function LegacySpace() {
  const id = location.pathname.split('/').filter(Boolean)[1] ?? '';
  return <Navigate to={`/dashboard/spaces/${encodeURIComponent(id)}${location.search}`} replace />;
}
