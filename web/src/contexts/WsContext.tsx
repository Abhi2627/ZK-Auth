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

type MessageHandler = (payload: unknown) => void;

interface WsContextValue {
  connected: boolean;
  send:      (msg: WsMessage) => void;
  subscribe: (type: WsMessageType, handler: MessageHandler) => () => void;
  reconnect: () => void;
}

const WsContext = createContext<WsContextValue | null>(null);

export function WsProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected]   = useState(false);
  const wsRef         = useRef<WebSocket | null>(null);
  const retryCount    = useRef(0);
  const retryTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokenPollRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const subscribers   = useRef(new Map<WsMessageType, Set<MessageHandler>>());
  const mountedRef    = useRef(true);
  const connectingRef = useRef(false);

  const connect = useCallback(() => {
    // Already open or connecting — skip
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    if (connectingRef.current) return;

    const token = getAccessToken();
    if (!token) return;   // no token yet — token poller will retry

    connectingRef.current = true;

    const url = `${WS_BASE}?token=${encodeURIComponent(token)}`;
    const ws  = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return; }
      connectingRef.current = false;
      setConnected(true);
      retryCount.current = 0;
      // Stop token polling — we're connected
      if (tokenPollRef.current) {
        clearInterval(tokenPollRef.current);
        tokenPollRef.current = null;
      }
    };

    ws.onmessage = (e: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(e.data) as WsMessage;
        const handlers = subscribers.current.get(msg.type);
        handlers?.forEach((h) => h(msg.payload));
      } catch { /* ignore malformed frames */ }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      connectingRef.current = false;
      setConnected(false);
      wsRef.current = null;
      // Exponential backoff retry
      const delay = Math.min(1_000 * 2 ** retryCount.current, 30_000);
      retryCount.current++;
      retryTimer.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      connectingRef.current = false;
      ws.close();
    };
  }, []);

  // Poll for token every 500ms until we get one, then connect
  const startTokenPoll = useCallback(() => {
    if (tokenPollRef.current) return; // already polling
    tokenPollRef.current = setInterval(() => {
      const token = getAccessToken();
      if (token) connect();
    }, 500);
  }, [connect]);

  useEffect(() => {
    mountedRef.current = true;

    // Try immediately — works if token already in sessionStorage
    connect();

    // If no token yet, start polling
    if (!getAccessToken()) startTokenPoll();

    return () => {
      mountedRef.current = false;
      if (retryTimer.current)  clearTimeout(retryTimer.current);
      if (tokenPollRef.current) clearInterval(tokenPollRef.current);
      wsRef.current?.close();
    };
  }, [connect, startTokenPoll]);

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

  // Manual reconnect — call this after login
  const reconnect = useCallback(() => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryCount.current = 0;
    wsRef.current?.close();
    connect();
    if (!getAccessToken()) startTokenPoll();
  }, [connect, startTokenPoll]);

  return (
    <WsContext.Provider value={{ connected, send, subscribe, reconnect }}>
      {children}
    </WsContext.Provider>
  );
}

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
