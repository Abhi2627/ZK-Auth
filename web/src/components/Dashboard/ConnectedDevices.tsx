/**
 * ConnectedDevices — Session / device management dashboard panel.
 *
 * Displays all active sessions with device label, IP, last active time.
 * Each row has a "Revoke" button that calls DELETE /session/:id and
 * immediately removes the row with an AnimatePresence exit animation.
 *
 * The current session is highlighted and its revoke button is labelled
 * "Sign out this device" (triggers full logout instead of just revoke).
 */

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion }                  from 'framer-motion';
import { getAccessToken }                           from '../../lib/api.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DeviceSession {
  id:                string;
  device_label:      string | null;
  ip_address:        string | null;
  risk_level:        string;
  created_at:        string;
  last_active_at:    string;
  is_current:        boolean;
}

const BASE = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001/api/v1';

async function apiDel(path: string): Promise<void> {
  const token = getAccessToken();
  await fetch(`${BASE}${path}`, {
    method:  'DELETE',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: 'include',
  });
}

async function apiGet<T>(path: string): Promise<T> {
  const token = getAccessToken();
  const res   = await fetch(`${BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ConnectedDevices() {
  const [sessions, setSessions]   = useState<DeviceSession[]>([]);
  const [loading,  setLoading]    = useState(true);
  const [revoking, setRevoking]   = useState<string | null>(null);
  const [error,    setError]      = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ sessions: DeviceSession[] }>('/session/devices');
      setSessions(data.sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load devices');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRevoke = async (sessionId: string, isCurrent: boolean) => {
    setRevoking(sessionId);
    try {
      await apiDel(isCurrent ? '/auth/logout' : `/session/${sessionId}`);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (isCurrent) {
        // Full logout — redirect to login
        window.location.href = '/login';
      }
    } catch {
      setError('Failed to revoke session — try again.');
    } finally {
      setRevoking(null);
    }
  };

  return (
    <section style={s.container}>
      <div style={s.header}>
        <h2 style={s.title}>Connected Devices</h2>
        <button style={s.refreshBtn} onClick={load} disabled={loading} aria-label="Refresh">
          {loading ? '⟳' : '↺'}
        </button>
      </div>

      {error && <p style={s.errorText}>{error}</p>}

      {loading && sessions.length === 0 && (
        <p style={s.dimText}>Loading sessions…</p>
      )}

      <ul style={s.list} role="list">
        <AnimatePresence initial={false}>
          {sessions.map((session) => (
            <motion.li
              key={session.id}
              layout
              initial={{ opacity: 0, height: 0, marginBottom: 0 }}
              animate={{ opacity: 1, height: 'auto', marginBottom: 8 }}
              exit={{   opacity: 0, height: 0, marginBottom: 0,
                        transition: { duration: 0.22, ease: 'easeIn' } }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
              style={{
                ...s.card,
                ...(session.is_current ? s.cardCurrent : {}),
              }}
            >
              {/* Device icon + label */}
              <div style={s.cardLeft}>
                <span style={s.icon} aria-hidden="true">
                  {guessDeviceIcon(session.device_label)}
                </span>
                <div>
                  <p style={s.deviceName}>
                    {session.device_label ?? 'Unknown Device'}
                    {session.is_current && (
                      <span style={s.currentBadge}>This device</span>
                    )}
                  </p>
                  <p style={s.meta}>
                    {session.ip_address ?? 'Unknown IP'}
                    {' · '}
                    Last active {formatRelative(session.last_active_at)}
                  </p>
                  <RiskBadge level={session.risk_level} />
                </div>
              </div>

              {/* Revoke button */}
              <button
                style={{
                  ...s.revokeBtn,
                  ...(session.is_current ? s.revokeBtnCurrent : {}),
                }}
                onClick={() => handleRevoke(session.id, session.is_current)}
                disabled={revoking === session.id}
                aria-label={`Revoke session on ${session.device_label ?? 'this device'}`}
              >
                {revoking === session.id
                  ? '…'
                  : session.is_current
                    ? 'Sign out'
                    : 'Revoke'}
              </button>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>

      {!loading && sessions.length === 0 && !error && (
        <p style={s.dimText}>No active sessions found.</p>
      )}

      {sessions.length > 1 && (
        <button
          style={s.revokeAllBtn}
          onClick={async () => {
            if (!confirm('Sign out all other devices?')) return;
            setRevoking('all');
            try {
              await apiDel('/session/all');
              await load();
            } finally {
              setRevoking(null);
            }
          }}
          disabled={revoking === 'all'}
        >
          {revoking === 'all' ? 'Signing out…' : 'Sign out all other devices'}
        </button>
      )}
    </section>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function RiskBadge({ level }: { level: string }) {
  const colours: Record<string, { bg: string; text: string }> = {
    LOW:      { bg: '#052e16', text: '#4ade80' },
    MEDIUM:   { bg: '#451a03', text: '#fb923c' },
    HIGH:     { bg: '#450a0a', text: '#f87171' },
    CRITICAL: { bg: '#3b0764', text: '#e879f9' },
  };
  const c = colours[level] ?? colours['LOW']!;
  return (
    <span style={{ ...s.riskBadge, background: c.bg, color: c.text }}>
      {level}
    </span>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function guessDeviceIcon(label: string | null): string {
  if (!label) return '💻';
  const l = label.toLowerCase();
  if (l.includes('iphone') || l.includes('android')) return '📱';
  if (l.includes('ipad') || l.includes('tablet'))    return '📱';
  if (l.includes('safari') || l.includes('chrome') || l.includes('firefox')) return '🖥️';
  return '💻';
}

function formatRelative(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const s = Math.floor(delta / 1_000);
  if (s < 60)   return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  container:     { padding: '0 0 24px' },
  header:        { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title:         { fontSize: 18, fontWeight: 700, margin: 0, color: '#e6edf3' },
  refreshBtn:    { background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: '#8b949e' },
  list:          { listStyle: 'none', padding: 0, margin: 0 },
  card:          { display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                   background: '#161b22', border: '1px solid #30363d', borderRadius: 8,
                   padding: '12px 14px', overflow: 'hidden' },
  cardCurrent:   { borderColor: '#388bfd', background: '#0d2149' },
  cardLeft:      { display: 'flex', alignItems: 'center', gap: 12 },
  icon:          { fontSize: 24 },
  deviceName:    { margin: 0, fontSize: 14, fontWeight: 600, color: '#e6edf3', display: 'flex', alignItems: 'center', gap: 8 },
  currentBadge:  { fontSize: 10, background: '#1f6feb', color: '#fff', padding: '2px 6px', borderRadius: 4 },
  meta:          { margin: '3px 0 4px', fontSize: 12, color: '#8b949e' },
  riskBadge:     { display: 'inline-block', fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 600, letterSpacing: '0.04em' },
  revokeBtn:     { background: 'none', border: '1px solid #6e7681', color: '#8b949e', borderRadius: 6,
                   padding: '5px 12px', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' },
  revokeBtnCurrent: { borderColor: '#da3633', color: '#f85149' },
  revokeAllBtn:  { marginTop: 12, width: '100%', background: 'none', border: '1px solid #30363d',
                   color: '#f85149', borderRadius: 6, padding: '8px', fontSize: 13, cursor: 'pointer' },
  dimText:       { color: '#8b949e', fontSize: 13, margin: 0 },
  errorText:     { color: '#f85149', fontSize: 13, marginBottom: 12 },
};
