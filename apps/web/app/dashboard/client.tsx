'use client';
import dynamic from 'next/dynamic';

// The pack draws with three.js, canvas and EventSource, all browser-only: render it on the client alone.
const Dashboard = dynamic(() => import('./pack/XYP3RNResearchRecordsDashboard'), {
  ssr: false,
  loading: () => <p style={{ padding: 24, color: '#78869a' }}>Loading the OS dashboard…</p>,
});

export function DashboardClient() {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, overflow: 'auto', background: '#090d15' }}>
      <Dashboard />
    </div>
  );
}
