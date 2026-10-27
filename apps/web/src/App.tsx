import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import Overview from './components/Overview'
import FacebookPages from './pages/FacebookPages'
import FacebookPageSettings from './pages/FacebookPageSettings'
import MetaBusinessHub from './pages/MetaBusinessHub'
import CrawlSources from './pages/CrawlSources'
import ReelFactory from './pages/ReelFactory'
import ImageFactory from './pages/ImageFactory'
import AIFactory from './pages/AIFactory'
import StatisticsPage from './pages/StatisticsPage'
import GoogleAnalyticsPage from './pages/GoogleAnalyticsPage'
import SystemSettingsPage from './pages/SystemSettingsPage'
import Login from './pages/Login'
import FanpageReport from './pages/FanpageReport'
import UserManagement from './pages/UserManagement'
import StoryTestStudio from './pages/StoryTestStudio'
import MetaBMGuidePage from './pages/MetaBMGuidePage'
import PageBrandingMuse from './pages/PageBrandingMuse'

import { useZTTeamAuthStore } from './stores/authStore'
import './index.css'

function ZTTeamProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useZTTeamAuthStore((state) => state.isAuthenticated);
  
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route 
          path="/" 
          element={
            <ZTTeamProtectedRoute>
              <Layout />
            </ZTTeamProtectedRoute>
          } 
        >
          <Route index element={<Overview />} />
          <Route path="facebook" element={<FacebookPages />} />
          <Route path="facebook/branding-muse" element={<PageBrandingMuse />} />
          <Route path="facebook/business-hub" element={<MetaBusinessHub />} />
          <Route path="meta-bm-guide" element={<MetaBMGuidePage />} />
          <Route path="facebook/pages/:id/settings" element={<FacebookPageSettings />} />
          <Route path="facebook/pages/:id/report" element={<FanpageReport />} />
          <Route path="crawl-sources" element={<CrawlSources />} />
          <Route path="ai-factory" element={<AIFactory />} />
          <Route path="reel-factory" element={<AIFactory />} />
          <Route path="image-factory" element={<AIFactory />} />
          <Route path="story-test" element={<StoryTestStudio />} />
          <Route path="statistics" element={<StatisticsPage />} />
          <Route path="google-analytics" element={<GoogleAnalyticsPage />} />
          <Route path="settings" element={<SystemSettingsPage />} />
          <Route path="users" element={<UserManagement />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
