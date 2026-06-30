import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { PageLoader } from '../components/Feedback';
import { AppShell } from './AppShell';
import { LoginPage } from '../pages/LoginPage';
import { DashboardPage } from '../pages/DashboardPage';
import { TreatiesPage } from '../pages/TreatiesPage';
import { TreatyDetailPage } from '../pages/TreatyDetailPage';
import { PartiesPage } from '../pages/PartiesPage';
import { PartyDetailPage } from '../pages/PartyDetailPage';
import { ClaimsPage } from '../pages/ClaimsPage';
import { ClaimDetailPage } from '../pages/ClaimDetailPage';
import { AccountingPage } from '../pages/AccountingPage';
import { AdminPage } from '../pages/AdminPage';

export function App() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return <PageLoader label="Restoring your session…" />;
  }

  if (status === 'anon') {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: location }} />} />
      </Routes>
    );
  }

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/login" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/treaties" element={<TreatiesPage />} />
        <Route path="/treaties/:id" element={<TreatyDetailPage />} />
        <Route path="/parties" element={<PartiesPage />} />
        <Route path="/parties/:id" element={<PartyDetailPage />} />
        <Route path="/claims" element={<ClaimsPage />} />
        <Route path="/claims/:id" element={<ClaimDetailPage />} />
        <Route path="/accounting" element={<AccountingPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </AppShell>
  );
}
