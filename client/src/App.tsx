import React, { useEffect, ReactNode } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useAuthStore } from './store/authStore'
import { useSettingsStore } from './store/settingsStore'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import TripPlannerPage from './pages/TripPlannerPage'
import FilesPage from './pages/FilesPage'
import AdminPage from './pages/AdminPage'
import SettingsPage from './pages/SettingsPage'
import VacayPage from './pages/VacayPage'
import AtlasPage from './pages/AtlasPage'
import PollsPage from './pages/PollsPage' // [460-fork] Milestone 9
import PublicPollPage from './pages/PublicPollPage' // [460-fork] Milestone 9
import SharedTripPage from './pages/SharedTripPage'
import SegmentAcceptPage from './pages/SegmentAcceptPage' // [460-fork] Milestone 4
import { startSyncWorker, stopSyncWorker } from './db/syncWorker' // [460-fork] Milestone 5
import { requestPersistentStorage } from './db/persistentStorage' // [460-fork] M1 follow-up
import { restoreFromSnapshot } from './db/offlineSnapshot' // [460-fork] M1 follow-up
import InAppNotificationsPage from './pages/InAppNotificationsPage.tsx'
import { ToastContainer } from './components/shared/Toast'
import SplashScreen from './components/shared/SplashScreen'
import { TranslationProvider, useTranslation } from './i18n'
import { authApi } from './api/client'
import { usePermissionsStore, PermissionLevel } from './store/permissionsStore'
import { useInAppNotificationListener } from './hooks/useInAppNotificationListener.ts'

interface ProtectedRouteProps {
  children: ReactNode
  adminRequired?: boolean
}

function ProtectedRoute({ children, adminRequired = false }: ProtectedRouteProps) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const user = useAuthStore((s) => s.user)
  const isLoading = useAuthStore((s) => s.isLoading)
  const appRequireMfa = useAuthStore((s) => s.appRequireMfa)
  const { t } = useTranslation()
  const location = useLocation()

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-slate-200 border-t-slate-900 rounded-full animate-spin"></div>
          <p className="text-slate-500 text-sm">{t('common.loading')}</p>
        </div>
      </div>
    )
  }

  if (!isAuthenticated) {
    const redirectParam = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/login?redirect=${redirectParam}`} replace />
  }

  if (
    appRequireMfa &&
    user &&
    !user.mfa_enabled &&
    location.pathname !== '/settings'
  ) {
    return <Navigate to="/settings?mfa=required" replace />
  }

  if (adminRequired && user && user.role !== 'admin') {
    return <Navigate to="/dashboard" replace />
  }

  return <>{children}</>
}

function RootRedirect() {
  const { isAuthenticated, isLoading } = useAuthStore()

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-10 h-10 border-4 border-slate-200 border-t-slate-900 rounded-full animate-spin"></div>
      </div>
    )
  }

  return <Navigate to={isAuthenticated ? '/dashboard' : '/login'} replace />
}

export default function App() {
  const { loadUser, isAuthenticated, demoMode, setDemoMode, setDevMode, setHasMapsKey, setServerTimezone, setAppRequireMfa, setTripRemindersEnabled } = useAuthStore()
  const { loadSettings } = useSettingsStore()

  useEffect(() => {
    if (!location.pathname.startsWith('/shared/') && !location.pathname.startsWith('/login')) {
      loadUser()
    }
    authApi.getAppConfig().then(async (config: { demo_mode?: boolean; dev_mode?: boolean; has_maps_key?: boolean; version?: string; timezone?: string; require_mfa?: boolean; trip_reminders_enabled?: boolean; permissions?: Record<string, PermissionLevel> }) => {
      if (config?.demo_mode) setDemoMode(true)
      if (config?.dev_mode) setDevMode(true)
      if (config?.has_maps_key !== undefined) setHasMapsKey(config.has_maps_key)
      if (config?.timezone) setServerTimezone(config.timezone)
      if (config?.require_mfa !== undefined) setAppRequireMfa(!!config.require_mfa)
      if (config?.trip_reminders_enabled !== undefined) setTripRemindersEnabled(config.trip_reminders_enabled)
      if (config?.permissions) usePermissionsStore.getState().setPermissions(config.permissions)

      if (config?.version) {
        const storedVersion = localStorage.getItem('trek_app_version')
        if (storedVersion && storedVersion !== config.version) {
          try {
            if ('caches' in window) {
              const names = await caches.keys()
              await Promise.all(names.map(n => caches.delete(n)))
            }
            if ('serviceWorker' in navigator) {
              const regs = await navigator.serviceWorker.getRegistrations()
              await Promise.all(regs.map(r => r.unregister()))
            }
          } catch {}
          localStorage.setItem('trek_app_version', config.version)
          window.location.reload()
          return
        }
        localStorage.setItem('trek_app_version', config.version)
      }
    }).catch(() => {})
  }, [])

  const { settings } = useSettingsStore()

  useInAppNotificationListener()

  useEffect(() => {
    if (isAuthenticated) {
      loadSettings()
    }
  }, [isAuthenticated])

  // [460-fork] Milestone 5 — drain queued mutations while the tab is open.
  // Runs once at app boot and periodically after that; lifecycle covers
  // both the initial mount and HMR.
  //
  // [460-fork] M1 follow-up — also at boot:
  //   1. Ask for persistent storage (may or may not be granted, but
  //      it's free upside on browsers that honour it).
  //   2. Try to restore the mutation queue from the OPFS snapshot.
  //      No-ops unless the live queue is empty AND OPFS has data —
  //      the catastrophic iOS-purged-our-storage scenario.
  useEffect(() => {
    void requestPersistentStorage()
    void restoreFromSnapshot()
      .then(({ restored, reason }) => {
        if (restored > 0) {
          console.info(`[460] Restored ${restored} queued mutation(s) from OPFS snapshot`)
        } else if (reason && reason !== 'no-snapshot' && reason !== 'opfs-unsupported' && reason !== 'live-queue-not-empty') {
          console.info(`[460] OPFS snapshot restore skipped: ${reason}`)
        }
      })
      .catch(() => {/* silent — restore is best-effort */})
    startSyncWorker()
    return () => {
      stopSyncWorker()
    }
  }, [])

  const location = useLocation()
  const isSharedPage = location.pathname.startsWith('/shared/')

  useEffect(() => {
    // Shared page always forces light mode
    if (isSharedPage) {
      document.documentElement.classList.remove('dark')
      const meta = document.querySelector('meta[name="theme-color"]')
      if (meta) meta.setAttribute('content', '#ffffff')
      return
    }

    const mode = settings.dark_mode
    const applyDark = (isDark: boolean) => {
      document.documentElement.classList.toggle('dark', isDark)
      const meta = document.querySelector('meta[name="theme-color"]')
      if (meta) meta.setAttribute('content', isDark ? '#09090b' : '#ffffff')
    }

    if (mode === 'auto') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      applyDark(mq.matches)
      const handler = (e: MediaQueryListEvent) => applyDark(e.matches)
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
    applyDark(mode === true || mode === 'dark')
  }, [settings.dark_mode, isSharedPage])

  return (
    <TranslationProvider>
      <SplashScreen />
      <ToastContainer />
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/shared/:token" element={<SharedTripPage />} />
        {/* [460-fork] Milestone 4 — accept a shared-segment invite. */}
        <Route
          path="/segments/accept/:token"
          element={
            <ProtectedRoute>
              <SegmentAcceptPage />
            </ProtectedRoute>
          }
        />
        <Route path="/register" element={<LoginPage />} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <DashboardPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/trips/:id"
          element={
            <ProtectedRoute>
              <TripPlannerPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/trips/:id/files"
          element={
            <ProtectedRoute>
              <FilesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin"
          element={
            <ProtectedRoute adminRequired>
              <AdminPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <SettingsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/vacay"
          element={
            <ProtectedRoute>
              <VacayPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/atlas"
          element={
            <ProtectedRoute>
              <AtlasPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/notifications"
          element={
            <ProtectedRoute>
              <InAppNotificationsPage />
            </ProtectedRoute>
          }
        />
        {/* [460-fork] Milestone 9 — pre-trip availability polls */}
        <Route
          path="/polls"
          element={
            <ProtectedRoute>
              <PollsPage />
            </ProtectedRoute>
          }
        />
        <Route path="/poll/:token" element={<PublicPollPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </TranslationProvider>
  )
}
