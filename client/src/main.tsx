import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { BrowserControlPopup } from './components/BrowserControlPopup'
import { initializeSocket } from '@/lib/socket'
import './index.css'

// Request notification permission once on load (not mid-session) so browser
// notifications work when the tab is in the background during HITL escalation.
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

// Popup mode: standalone browser control window
if (window.location.search.includes('popup=browser-control')) {
  initializeSocket();
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <BrowserControlPopup />
    </React.StrictMode>,
  );
} else {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}