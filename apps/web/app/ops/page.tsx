'use client';

import React, { useState } from 'react';
import { VoiceOrbContainer } from '../../components/orbs/VoiceOrbContainer';

// Domain Configuration Matrix with distinct color signatures & assigned agent suites
const DOMAINS = [
  { id: 'core', name: 'Core System', color: '#00F0FF', agent: 'Jarvis Core', role: 'Master Orchestration' },
  { id: 'knowledge', name: 'Knowledge', color: '#3B82F6', agent: 'Scribe & Archivist', role: 'Vault Staging & Indexing' },
  { id: 'research', name: 'Research', color: '#A855F7', agent: 'Scout AI', role: 'Evidence Extraction' },
  { id: 'records', name: 'Records', color: '#10B981', agent: 'Ledger Guard', role: 'Append-Only Ledger (Port 5433)' },
  { id: 'tech', name: 'Tech Ops', color: '#F59E0B', agent: 'Pipeline Engine', role: 'Runtime Telemetry (Port 4700)' },
  { id: 'governance', name: 'Governance', color: '#EF4444', agent: 'Gatekeeper', role: 'Human Sign-off & Approvals' }
];

export default function OperationalDashboard() {
  const [selectedDomain, setSelectedDomain] = useState<typeof DOMAINS[0] | null>(null);
  const [taskPrompt, setTaskPrompt] = useState('');
  const [approvalQueue, setApprovalQueue] = useState([
    { id: 'TASK-2026-089', domain: 'Governance', action: 'Commit Vault Ingestion to Canonical', agent: 'Scribe' },
    { id: 'TASK-2026-090', domain: 'Records', action: 'Verify Rights Split Hash', agent: 'Ledger Guard' }
  ]);

  const handleExecuteTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskPrompt || !selectedDomain) return;

    // Stage task into the Human-in-the-Loop approval queue — never run directly
    setApprovalQueue(prev => [
      ...prev,
      {
        id: `TASK-2026-09${prev.length + 1}`,
        domain: selectedDomain.name,
        action: taskPrompt,
        agent: selectedDomain.agent
      }
    ]);
    setTaskPrompt('');
    setSelectedDomain(null);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-mono p-6">
      {/* HUD Header & Voice Telemetry */}
      <header className="flex justify-between items-center border-b border-cyan-500/20 pb-4 mb-6">
        <div className="flex items-center gap-4">
          <VoiceOrbContainer mode="signal" state="idle" size={44} />
          <div>
            <h1 className="text-xl font-bold tracking-wider text-cyan-400">XYP3RN OS // OPERATIONAL DASHBOARD</h1>
            <p className="text-xs text-slate-400">Surface 2: Web Operational Dashboard | Vault: Connected</p>
          </div>
        </div>
        <div className="flex gap-4 text-xs">
          <span className="px-3 py-1 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 rounded">
            DB: PostgreSQL 16 (:5433) [Immutable]
          </span>
          <span className="px-3 py-1 bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 rounded">
            Galaxy: Active (:4700)
          </span>
        </div>
      </header>

      {/* Main Operational Matrix */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1">

        {/* Domain Selection & Agent Suite */}
        <div className="lg:col-span-2 bg-slate-900/50 border border-slate-800 rounded-xl p-6 flex flex-col">
          <h2 className="text-sm font-semibold text-slate-300 mb-4 tracking-wide">
            COLOR-CODED DOMAIN AGENT MATRIX
          </h2>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 flex-1">
            {DOMAINS.map((domain) => (
              <div
                key={domain.id}
                onClick={() => setSelectedDomain(domain)}
                className="p-4 rounded-lg border bg-slate-900/80 cursor-pointer hover:scale-[1.02] transition-all flex flex-col justify-between"
                style={{ borderColor: `${domain.color}40`, boxShadow: `0 0 15px ${domain.color}10` }}
              >
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-3 h-3 rounded-full" style={{ backgroundColor: domain.color }} />
                    <span className="font-bold text-sm" style={{ color: domain.color }}>{domain.name}</span>
                  </div>
                  <p className="text-xs text-slate-300 font-medium">{domain.agent}</p>
                  <p className="text-[11px] text-slate-500 mt-1">{domain.role}</p>
                </div>
                <button
                  className="mt-4 w-full py-1.5 rounded text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
                >
                  Stage Agent Task
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Human-In-The-Loop Approval Queue */}
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-6 flex flex-col">
          <h2 className="text-sm font-semibold text-slate-300 mb-4 tracking-wide flex justify-between items-center">
            <span>APPROVAL QUEUE</span>
            <span className="text-xs text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/30">
              Human Sign-off Required
            </span>
          </h2>

          <div className="flex-1 space-y-3 overflow-y-auto max-h-[400px]">
            {approvalQueue.length === 0 ? (
              <p className="text-xs text-slate-500">No pending executions.</p>
            ) : (
              approvalQueue.map((item) => (
                <div key={item.id} className="p-3 bg-slate-900 border border-slate-800 rounded-lg text-xs space-y-2">
                  <div className="flex justify-between text-slate-400">
                    <span>{item.id}</span>
                    <span className="text-cyan-400">{item.agent}</span>
                  </div>
                  <p className="text-slate-200">{item.action}</p>
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={() => setApprovalQueue(prev => prev.filter(q => q.id !== item.id))}
                      className="flex-1 py-1 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-400 rounded text-[11px]"
                    >
                      Approve & Run
                    </button>
                    <button
                      onClick={() => setApprovalQueue(prev => prev.filter(q => q.id !== item.id))}
                      className="flex-1 py-1 bg-rose-600/20 hover:bg-rose-600/30 border border-rose-500/40 text-rose-400 rounded text-[11px]"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Agent Task Dispatch Modal */}
      {selectedDomain && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 border border-slate-700 rounded-xl max-w-md w-full p-6 space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-base font-bold" style={{ color: selectedDomain.color }}>
                Execute Task: {selectedDomain.agent}
              </h3>
              <button onClick={() => setSelectedDomain(null)} className="text-slate-400 hover:text-slate-200">✕</button>
            </div>

            <form onSubmit={handleExecuteTask} className="space-y-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Task Specification</label>
                <textarea
                  value={taskPrompt}
                  onChange={(e) => setTaskPrompt(e.target.value)}
                  placeholder={`Describe task for ${selectedDomain.agent}...`}
                  className="w-full bg-slate-950 border border-slate-800 rounded p-2 text-xs text-slate-100 focus:outline-none focus:border-cyan-500 h-24 resize-none"
                />
              </div>

              <div className="text-[11px] text-amber-400/90 bg-amber-500/10 p-2 rounded border border-amber-500/20">
                Notice: Task will be staged in the Approval Queue for human sign-off before executing.
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedDomain(null)}
                  className="px-3 py-1.5 bg-slate-800 text-slate-300 text-xs rounded hover:bg-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-slate-950 text-xs font-bold rounded"
                >
                  Stage Task
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
