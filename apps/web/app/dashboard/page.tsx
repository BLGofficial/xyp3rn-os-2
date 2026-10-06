import { DashboardClient } from './client';

export const metadata = { title: 'XYP3RN Agentic OS · Research & Records Dashboard' };

// The XYP3RN OS Dashboard Pack (Research, Knowledge, Records): full screen over the app shell, like /hud. Its reads
// are /api/v1/* (app/api/v1/_lib.ts); imports and new notebooks are not wired yet, so those panels say not connected.
export default function DashboardPage() {
  return <DashboardClient />;
}
