'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from 'react';
import type { BehaviorEvent, WsMessage } from '@zk-auth/types';

const FLUSH_INTERVAL_MS    = 500;
const BATCH_SIZE           = 20;
const MAX_DWELL_MS         = 2_000;
const RING_BUFFER_CAPACITY = 200;

interface RawMouseEvent   { type: 'MOUSE_MOVE'; x: number; y: number; ts: number }
interface RawKeyDownEvent { type: 'KEY_DOWN';   code: string; ts: number }
interface RawKeyUpEvent   { type: 'KEY_UP';     code: string; ts: number }
interface RawScrollEvent  { type: 'SCROLL';     delta: number; ts: number }
interface RawTouchEvent   { type: 'TOUCH';      pressure: number; ts: number }
interface RawFocusEvent   { type: 'FOCUS_LOSS'; ts: number }

type RawEvent =
  | RawMouseEvent | RawKeyDownEvent | RawKeyUpEvent
  | RawScrollEvent | RawTouchEvent | RawFocusEvent;

interface TelemetryContextValue {
  isCollecting: boolean;
  start: (sessionId: string, sendFn: (msg: WsMessage) => void) => void;
  stop: () => void;
}

const TelemetryContext = createContext<TelemetryContextValue | null>(null);

async function hashPageContext(pathname: string): Promise<string> {
  const encoded = new TextEncoder().encode(pathname);
  const buf = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function TelemetryProvider({ children }: { children: React.ReactNode }) {
  const isCollecting   = useRef(false);
  const sessionIdRef   = useRef<string>('');
  const sendFnRef      = useRef<((msg: WsMessage) => void) | null>(null);
  const seqNumRef      = useRef(0);
  const pageContextRef = useRef<string>('');
  const ringBuffer     = useRef<RawEvent[]>([]);
  const lastMousePos   = useRef<{ x: number; y: number; ts: number } | null>(null);
  const keyDownTimes   = useRef<Map<string, number>>(new Map());
  const batchBuffer    = useRef<BehaviorEvent[]>([]);
  const flushTimer     = useRef<ReturnType<typeof setInterval> | null>(null);
  const rafHandle      = useRef<number | null>(null);

  useEffect(() => {
    hashPageContext(window.location.pathname)
      .then((h) => { pageContextRef.current = h; })
      .catch(() => {});
  }, []);

  const onMouseMove = useCallback((e: MouseEvent) => {
    if (!isCollecting.current) return;
    const buf = ringBuffer.current;
    if (buf.length >= RING_BUFFER_CAPACITY) buf.shift();
    buf.push({ type: 'MOUSE_MOVE', x: e.clientX, y: e.clientY, ts: Date.now() });
  }, []);

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isCollecting.current) return;
    if (!keyDownTimes.current.has(e.code)) keyDownTimes.current.set(e.code, Date.now());
    const buf = ringBuffer.current;
    if (buf.length >= RING_BUFFER_CAPACITY) buf.shift();
    buf.push({ type: 'KEY_DOWN', code: e.code, ts: Date.now() });
  }, []);

  const onKeyUp = useCallback((e: KeyboardEvent) => {
    if (!isCollecting.current) return;
    const downTs = keyDownTimes.current.get(e.code);
    keyDownTimes.current.delete(e.code);
    const buf = ringBuffer.current;
    if (buf.length >= RING_BUFFER_CAPACITY) buf.shift();
    buf.push({
      type: 'KEY_UP', code: e.code, ts: Date.now(),
      ...(downTs !== undefined ? { dwell: Math.min(Date.now() - downTs, MAX_DWELL_MS) } : {}),
    } as RawKeyUpEvent & { dwell?: number });
  }, []);

  const onScroll = useCallback((e: Event) => {
    if (!isCollecting.current) return;
    const delta = (e as WheelEvent).deltaY ?? 0;
    const buf = ringBuffer.current;
    if (buf.length >= RING_BUFFER_CAPACITY) buf.shift();
    buf.push({ type: 'SCROLL', delta, ts: Date.now() });
  }, []);

  const onTouch = useCallback((e: TouchEvent) => {
    if (!isCollecting.current) return;
    const pressure = e.changedTouches[0]?.force ?? 0;
    const buf = ringBuffer.current;
    if (buf.length >= RING_BUFFER_CAPACITY) buf.shift();
    buf.push({ type: 'TOUCH', pressure, ts: Date.now() });
  }, []);

  const onFocusLoss = useCallback(() => {
    if (!isCollecting.current) return;
    const buf = ringBuffer.current;
    if (buf.length >= RING_BUFFER_CAPACITY) buf.shift();
    buf.push({ type: 'FOCUS_LOSS', ts: Date.now() });
  }, []);

  const flushBatch = useCallback(() => {
    const batch = batchBuffer.current.splice(0, batchBuffer.current.length);
    if (!batch.length || !sendFnRef.current) return;
    for (const event of batch) {
      sendFnRef.current({ type: 'BEHAVIOR_EVENT', payload: event, ts: Date.now() });
    }
  }, []);

  const drainBuffer = useCallback(() => {
    if (!isCollecting.current) return;
    const raw = ringBuffer.current.splice(0, ringBuffer.current.length);
    if (!raw.length) { rafHandle.current = requestAnimationFrame(drainBuffer); return; }

    for (const ev of raw) {
      let behaviorEvent: BehaviorEvent | null = null;

      if (ev.type === 'MOUSE_MOVE') {
        const prev = lastMousePos.current;
        let velocity = 0;
        if (prev) {
          const dx = ev.x - prev.x, dy = ev.y - prev.y, dt = ev.ts - prev.ts;
          if (dt > 0) velocity = Math.sqrt(dx * dx + dy * dy) / dt;
        }
        lastMousePos.current = { x: ev.x, y: ev.y, ts: ev.ts };
        behaviorEvent = { session_id: sessionIdRef.current, timestamp_ms: ev.ts, event_type: 'MOUSE_MOVE', mouse_velocity: velocity, sequence_num: seqNumRef.current++, page_context: pageContextRef.current };
      } else if (ev.type === 'KEY_UP') {
        const dwellEv = ev as RawKeyUpEvent & { dwell?: number };
        behaviorEvent = { session_id: sessionIdRef.current, timestamp_ms: ev.ts, event_type: 'KEY_UP', key_dwell_ms: dwellEv.dwell ?? 0, sequence_num: seqNumRef.current++, page_context: pageContextRef.current };
      } else if (ev.type === 'SCROLL') {
        behaviorEvent = { session_id: sessionIdRef.current, timestamp_ms: ev.ts, event_type: 'SCROLL', scroll_delta: (ev as RawScrollEvent).delta, sequence_num: seqNumRef.current++, page_context: pageContextRef.current };
      } else if (ev.type === 'TOUCH') {
        behaviorEvent = { session_id: sessionIdRef.current, timestamp_ms: ev.ts, event_type: 'TOUCH', touch_pressure: (ev as RawTouchEvent).pressure, sequence_num: seqNumRef.current++, page_context: pageContextRef.current };
      } else if (ev.type === 'FOCUS_LOSS') {
        behaviorEvent = { session_id: sessionIdRef.current, timestamp_ms: ev.ts, event_type: 'FOCUS_LOSS', sequence_num: seqNumRef.current++, page_context: pageContextRef.current };
      }

      if (behaviorEvent) {
        batchBuffer.current.push(behaviorEvent);
        if (batchBuffer.current.length >= BATCH_SIZE) flushBatch();
      }
    }
    rafHandle.current = requestAnimationFrame(drainBuffer);
  }, [flushBatch]);

  const start = useCallback((sessionId: string, sendFn: (msg: WsMessage) => void) => {
    if (isCollecting.current) return;
    sessionIdRef.current = sessionId;
    sendFnRef.current    = sendFn;
    isCollecting.current = true;
    seqNumRef.current    = 0;

    window.addEventListener('mousemove',  onMouseMove,  { passive: true });
    window.addEventListener('keydown',    onKeyDown);
    window.addEventListener('keyup',      onKeyUp);
    window.addEventListener('wheel',      onScroll,     { passive: true });
    window.addEventListener('touchstart', onTouch,      { passive: true });
    window.addEventListener('blur',       onFocusLoss);

    rafHandle.current  = requestAnimationFrame(drainBuffer);
    flushTimer.current = setInterval(flushBatch, FLUSH_INTERVAL_MS);
  }, [onMouseMove, onKeyDown, onKeyUp, onScroll, onTouch, onFocusLoss, drainBuffer, flushBatch]);

  const stop = useCallback(() => {
    if (!isCollecting.current) return;
    isCollecting.current = false;

    window.removeEventListener('mousemove',  onMouseMove);
    window.removeEventListener('keydown',    onKeyDown);
    window.removeEventListener('keyup',      onKeyUp);
    window.removeEventListener('wheel',      onScroll);
    window.removeEventListener('touchstart', onTouch);
    window.removeEventListener('blur',       onFocusLoss);

    if (rafHandle.current  !== null) cancelAnimationFrame(rafHandle.current);
    if (flushTimer.current !== null) clearInterval(flushTimer.current);

    flushBatch();
    ringBuffer.current    = [];
    batchBuffer.current   = [];
    keyDownTimes.current.clear();
    lastMousePos.current  = null;
    sendFnRef.current     = null;
  }, [onMouseMove, onKeyDown, onKeyUp, onScroll, onTouch, onFocusLoss, flushBatch]);

  useEffect(() => () => stop(), [stop]);

  return (
    <TelemetryContext.Provider value={{ isCollecting: isCollecting.current, start, stop }}>
      {children}
    </TelemetryContext.Provider>
  );
}

export function useTelemetry(): TelemetryContextValue {
  const ctx = useContext(TelemetryContext);
  if (!ctx) throw new Error('useTelemetry must be used within TelemetryProvider');
  return ctx;
}
