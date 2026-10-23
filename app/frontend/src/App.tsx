import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAccess, useAuth } from "./lib/auth";
import type { ReactNode } from "react";
import type { Permission } from "./lib/types";
import { Layout } from "./components/Layout";
import { PageLoader } from "./components/ui/Spinner";
import LoginPage from "./pages/Login";
import SetupPage from "./pages/Setup";
import OverviewPage from "./pages/Overview";
import DevicesPage from "./pages/Devices";
import DeviceDetailPage from "./pages/DeviceDetail";
import ConnectionsPage from "./pages/Connections";
import CredentialsPage from "./pages/Credentials";
import ActivityPage from "./pages/Activity";
import SettingsPage from "./pages/Settings";
import TransferPage from "./pages/Transfer";
import StatisticsPage from "./pages/Statistics";
import DataMissingPage from "./pages/DataMissing";
import UsersPage from "./pages/Users";
import RecordingsPage from "./pages/Recordings";

/** Sends people without the right back to Overview instead of showing a broken page. */
function Require({ admin, perm, children }: { admin?: boolean; perm?: Permission; children: ReactNode }) {
  const { isAdmin, can } = useAccess();
  if ((admin && !isAdmin) || (perm && !can(perm))) return <Navigate to="/" replace />;
  return <>{children}</>;
}

// The remote session workspace loads the Guacamole client on demand.
const SessionPage = lazy(() => import("./pages/Session"));
const WorkspacePage = lazy(() => import("./pages/Workspace"));
const WatchPage = lazy(() => import("./pages/Watch"));

export default function App() {
  const { state } = useAuth();
  if (state.status === "loading") return <PageLoader label="Starting…" />;
  if (state.status === "setup") return <SetupPage />;
  if (state.status === "blocked") return <DataMissingPage />;
  if (state.status === "anonymous") return <LoginPage />;
  return (
    <Routes>
      <Route
        path="/workspace"
        element={
          <Suspense fallback={<PageLoader label="Loading workspace…" />}>
            <WorkspacePage />
          </Suspense>
        }
      />
      <Route
        path="/watch/:token"
        element={
          <Suspense fallback={<PageLoader label="Opening shared session…" />}>
            <WatchPage />
          </Suspense>
        }
      />
      <Route
        path="/connect/:connectionId"
        element={
          <Suspense fallback={<PageLoader label="Loading session…" />}>
            <SessionPage />
          </Suspense>
        }
      />
      <Route element={<Layout />}>
        <Route index element={<OverviewPage />} />
        <Route path="devices" element={<DevicesPage />} />
        <Route path="devices/:id" element={<DeviceDetailPage />} />
        <Route path="favorites" element={<DevicesPage favoritesOnly />} />
        <Route path="statistics" element={<StatisticsPage />} />
        <Route path="users" element={<Require admin><UsersPage /></Require>} />
        <Route path="transfer" element={<Require perm="files.use"><TransferPage /></Require>} />
        <Route path="connections" element={<ConnectionsPage />} />
        <Route path="credentials" element={<CredentialsPage />} />
        <Route path="recordings" element={<RecordingsPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
