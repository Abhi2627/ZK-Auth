/**
 * WebSocket Context — shared WS connection + message subscription
 *
 * Provides a single authenticated WebSocket connection to all components.
 * Components subscribe to specific message types via useWsSubscribe().
 *
 * Connection lifecycle:
 *   1. WsProvider mounts → connects when access token is available.
 *   2. Reconnects with exponential backoff on unexpected disconnect.
 *   3. Disconnects cleanly on logout (token cleared).
 *
 * The token is passed as a query parameter because the WebSocket upgrade
 * handshake does not support Authorization headers in browsers.
 */

'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { getAccessToken } from '../lib/api';
import type { WsMessage, WsMessageType } from '@zk-auth/types';

const WS_BASE =
  process.env['NEXT_PUBLIC_WS_URL'] ?? 'ws://localhost:3001/api/v1/session/telemetry';

// ─── Types ───────────────────────────────────────────────────────────────────

type MessageHandler = (payload: unknown) => void;

interface WsContextValue {
  connected: boolean;
  send: (msg: WsMessage) => void;
  subscribe: (type: WsMessageType, handler: MessageHandler) => () => void;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const WsContext = createContext<WsContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function WsProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const wsRef         = useRef<WebSocket | null>(null);
  const retryCount    = useRef(0);
  const retryTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subscribers   = useRef(new Map<WsMessageType, Set<MessageHandler>>());
  const mountedRef    = useRef(true);

  const connect = useCallback(() => {
    const token = getAccessToken();
    if (!token) return;

    const url = `${WS_BASE}?token=${encodeURIComponent(token)}`;
    const ws  = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return; }
      setConnected(true);
      retryCount.current = 0;
    };

    ws.onmessage = (e: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(e.data) as WsMessage;
        const handlers = subscribers.current.get(msg.type);
        handlers?.forEach((h) => h(msg.payload));
      } catch {
        // Ignore malformed frames
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setConnected(false);
      wsRef.current = null;
      const delay = Math.min(1_000 * 2 ** retryCount.current, 30_000);
      retryCount.current++;
      retryTimer.current = setTimeout(connect, delay);
    };

    ws.onerror = () => { ws.close(); };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: WsMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const subscribe = useCallback(
    (type: WsMessageType, handler: MessageHandler): (() => void) => {
      if (!subscribers.current.has(type)) {
        subscribers.current.set(type, new Set());
      }
      subscribers.current.get(type)!.add(handler);
      return () => subscribers.current.get(type)?.delete(handler);
    },
    [],
  );

  return (
    <WsContext.Provider value={{ connected, send, subscribe }}>
      {children}
    </WsContext.Provider>
  );
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

export function useWs(): WsContextValue {
  const ctx = useContext(WsContext);
  if (!ctx) throw new Error('useWs must be used within WsProvider');
  return ctx;
}

export function useWsSubscribe<T = unknown>(
  type: WsMessageType,
  handler: (payload: T) => void,
): void {
  const { subscribe } = useWs();
  useEffect(() => {
    return subscribe(type, handler as MessageHandler);
  }, [subscribe, type, handler]);
}
