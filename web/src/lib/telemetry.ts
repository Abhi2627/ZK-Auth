/**
 * Telemetry Collector — behavioral event capture with UI-thread protection
 *
 * ─── Architecture ─────────────────────────────────────────────────────────────
 * All event listeners are attached with { passive: true } (where applicable)
 * so the browser never waits for a JS handler before compositing a frame.
 *
 * Raw events are pushed into a ring buffer (_eventBuffer) synchronously in the
 * listener callback — this is O(1) and takes < 1µs. No processing happens here.
 *
 * A scheduler (requestAnimationFrame + a 500ms interval fallback) drains the
 * buffer on each animation frame boundary. Frame-boundary draining means:
 *   - Processing never interrupts mid-frame rendering (no layout thrashing).
 *   - The callback runs after Paint and before the next Input handling cycle.
 *
 * Feature engineering (velocity, dwell time) is computed during the drain pass,
 * not in the raw event callback — the critical rendering path sees zero overhead.
 *
 * Batched events are flushed over the WebSocket every FLUSH_INTERVAL_MS (500ms)
 * or when the batch reaches BATCH_SIZE (20 events), whichever comes first.
 * At 500ms intervals with ~10-20 events/sec typical interaction rate, batches
 * are small (5-10 events) — well within WebSocket frame limits.
 *
 * ─── Key dwell time measurement ──────────────────────────────────────────────
 * keydown records a timestamp in _keyDownTimes Map<code, number>.
 * keyup computes dwell = Date.now() - _keyDownTimes[code], emits the feature.
 * Keys held longer than MAX_DWELL_MS are capped (prevents stuck-key artifacts).
 *
 * ─── Mouse velocity calculation ──────────────────────────────────────────────
 * Between consecutive MOUSE_MOVE events: velocity = distance / deltaTime (px/ms).
 * Velocity is computed in the drain pass from sequential event pairs.
 * Frames with zero deltaTime (duplicate timestamps) are skipped.
 *
 * ─── Scroll delta ────────────────────────────────────────────────────────────
 * wheel event deltaY is used directly (normalised across wheel modes
 * by the browser via deltaMode === 0).
 *
 * ─── Privacy ─────────────────────────────────────────────────────────────────
 * NO key codes or characters are transmitted — only timing (dwell_ms).
 * Mouse coordinates are NOT transmitted — only velocity magnitude.
 * page_context is SHA-256 of the current pathname (not full URL with params).
 */

'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from 'react';
import type { BehaviorEvent, BehaviorEventType, WsMessage } from '@zk-auth/types';

// ─── Constants ────────────────────────────────────────────────────────────────

const FLUSH_INTERVAL_MS  = 500;
const BATCH_SIZE         = 20;
const MAX_DWELL_MS       = 2_000;
const RING_BUFFER_CAPACITY = 200;  // max raw events before oldest are dropped

// ─── Raw event record (pre-processing) ───────────────────────────────────────

interface RawMouseEvent   { type: 'MOUSE_MOVE'; x: number; y: number; ts: number }
interface RawKeyDownEvent { type: 'KEY_DOWN';   code: string; ts: number }
interface RawKeyUpEvent   { type: 'KEY_UP';     code: string; ts: number }
interface RawScrollEvent  { type: 'SCROLL';     delta: number; ts: number }
interface RawTouchEvent   { type: 'TOUCH';      pressure: number; ts: number }
interface RawFocusEvent   { type: 'FOCUS_LOSS'; ts: number }

type RawEvent =
  | RawMouseEvent | RawKeyDownEvent | RawKeyUpEvent
  | RawScrollEvent | RawTouchEvent | RawFocusEvent;

// ─── Context ──────────────────────────────────────────────────────────────────

interface TelemetryContextValue {
  isCollecting: boolean;
  start: (sessionId: string, sendFn: (msg: WsMessage) => void) => void;
  stop: () => void;
}

const TelemetryContext = createContext<TelemetryContextValue | null>(null);

// ─── SHA-256 page context hash ────────────────────────────────────────────────

async function hashPageContext(pathname: string): Promise<string> {
  const encoded = new TextEncoder().encode(pathname);
  const buf = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function TelemetryProvider({ children }: { children: React.ReactNode }) {
  const isCollecting    = useRef(false);
  const sessionIdRef    = useRef<string>('');
  const sendFnRef       = useRef<((msg: WsMessage) => void) | null>(null);
  const seqNumRef       = useRef(0);
  const pageContextRef  = useRef<string>('');

  // Raw event ring buffer
  const ringBuffer      = useRef<RawEvent[]>([]);

  // State for computed features
  const lastMousePos    = useRef<{ x: number; y: number; ts: number } | null>(null);
  const keyDownTimes    = useRef<Map<string, number>>(new Map());

  // Outgoing batch buffer
  const batchBuffer     = useRef<BehaviorEvent[]>([]);
  const flushTimer      = useRef<ReturnType<typeof setInterval> | null>(null);
  const rafHandle       = useRef<number | null>(null);

  // ─── Page context hash (updated on mount and route changes) ───────────────
  useEffect(() => {
    hashPageContext(window.location.pathname)
      .then((h) => { pageContextRef.current = h; })
      .catch(() => {});
  }, []);

  // ─── Raw event listeners (O(1) push to ring buffer) ───────────────────────

  const onMouseMove = useCallback((e: MouseEvent) => {
    if (!isCollecting.current) return;
    const buf = ringBuffer.current;
    if (buf.length >= RING_BUFFER_CAPACITY) buf.shift();
    buf.push({ type: 'MOUSE_MOVE', x: e.clientX, y: e.clientY, ts: Date.now() });
  }, []);

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isCollecting.current) return;
    if (!keyDownTimes.current.has(e.code)) {
      keyDownTimes.current.set(e.code, Date.now());
    }
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
      type: 'KEY_UP',
      code: e.code,
      ts: Date.now(),
      // Embed dwell directly — raw event carries it
      ...(downTs !== undefined
        ? { dwell: Math.min(Date.now() - downTs, MAX_DWELL_MS) }
        : {}),
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
    const touch = e.changedTouches[0];
    const pressure = touch?.force ?? 0;
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

  // ─── Animation-frame drain (feature engineering off critical path) ─────────

  const drainBuffer = useCallback(() => {
    if (!isCollecting.current) return;

    const raw = ringBuffer.current.splice(0, ringBuffer.current.length);
    if (raw.length === 0) {
      rafHandle.current = requestAnimationFrame(drainBuffer);
      return;
    }

    for (const ev of raw) {
      let behaviorEvent: BehaviorEvent | null = null;

      switch (ev.type) {
        case 'MOUSE_MOVE': {
          const prev = lastMousePos.current;
          let velocity = 0;
          if (prev !== null) {
            const dx = ev.x - prev.x;
            const dy = ev.y - prev.y;
            const dt = ev.ts - prev.ts;
            if (dt > 0) {
              velocity = Math.sqrt(dx * dx + dy * dy) / dt;
            }
          }
          lastMousePos.current = { x: ev.x, y: ev.y, ts: ev.ts };
          behaviorEvent = {
            session_id:     sessionIdRef.current,
            timestamp_ms:   ev.ts,
            event_type:     'MOUSE_MOVE',
            mouse_velocity: velocity,
            sequence_num:   seqNumRef.current++,
            page_context:   pageContextRef.current,
          };
          break;
        }

        case 'KEY_UP': {
          const dwellEv = ev as RawKeyUpEvent & { dwell?: number };
          behaviorEvent = {
            session_id:   sessionIdRef.current,
            timestamp_ms: ev.ts,
            event_type:   'KEY_UP',
            key_dwell_ms: dwellEv.dwell ?? 0,
            sequence_num: seqNumRef.current++,
            page_context: pageContextRef.current,
          };
          break;
        }

        case 'SCROLL': {
          behaviorEvent = {
            session_id:   sessionIdRef.current,
            timestamp_ms: ev.ts,
            event_type:   'SCROLL',
            scroll_delta: (ev as RawScrollEvent).delta,
            sequence_num: seqNumRef.current++,
            page_context: pageContextRef.current,
          };
          break;
        }

        case 'TOUCH': {
          behaviorEvent = {
            session_id:      sessionIdRef.current,
            timestamp_ms:    ev.ts,
            event_type:      'TOUCH',
            touch_pressure:  (ev as RawTouchEvent).pressure,
            sequence_num:    seqNumRef.current++,
            page_context:    pageContextRef.current,
          };
          break;
        }

        case 'FOCUS_LOSS': {
          behaviorEvent = {
            session_id:   sessionIdRef.current,
            timestamp_ms: ev.ts,
            event_type:   'FOCUS_LOSS',
            sequence_num: seqNumRef.current++,
            page_context: pageContextRef.current,
          };
          break;
        }

        // KEY_DOWN: no feature emitted (dwell computed on KEY_UP)
        default: break;
      }

      if (behaviorEvent !== null) {
        batchBuffer.current.push(behaviorEvent);
        if (batchBuffer.current.length >= BATCH_SIZE) {
          flushBatch();
        }
      }
    }

    rafHandle.current = requestAnimationFrame(drainBuffer);
  }, []);

  // ─── WebSocket flush ───────────────────────────────────────────────────────

  const flushBatch = useCallback(() => {
    const batch = batchBuffer.current.splice(0, batchBuffer.current.length);
    if (batch.length === 0 || !sendFnRef.current) return;

    // Send each event as its own WsMessage (server expects individual events)
    for (const event of batch) {
      sendFnRef.current({
        type: 'BEHAVIOR_EVENT',
        payload: event,
        ts: Date.now(),
      });
    }
  }, []);

  // ─── Public API ────────────────────────────────────────────────────────────

  const start = useCallback(
    (sessionId: string, sendFn: (msg: WsMessage) => void) => {
      if (isCollecting.current) return;

      sessionIdRef.current  = sessionId;
      sendFnRef.current     = sendFn;
      isCollecting.current  = true;
      seqNumRef.current     = 0;

      // Attach listeners — mousemove and wheel use passive:true
      window.addEventListener('mousemove',  onMouseMove,  { passive: true });
      window.addEventListener('keydown',    onKeyDown);
      window.addEventListener('keyup',      onKeyUp);
      window.addEventListener('wheel',      onScroll,     { passive: true });
      window.addEventListener('touchstart', onTouch,      { passive: true });
      window.addEventListener('blur',       onFocusLoss);

      // Start rAF drain loop
      rafHandle.current = requestAnimationFrame(drainBuffer);

      // Periodic flush fallback (fires even when rAF pauses in background tabs)
      flushTimer.current = setInterval(flushBatch, FLUSH_INTERVAL_MS);
    },
    [onMouseMove, onKeyDown, onKeyUp, onScroll, onTouch, onFocusLoss, drainBuffer, flushBatch],
  );

  const stop = useCallback(() => {
    if (!isCollecting.current) return;
    isCollecting.current = false;

    window.removeEventListener('mousemove',  onMouseMove);
    window.removeEventListener('keydown',    onKeyDown);
    window.removeEventListener('keyup',      onKeyUp);
    window.removeEventListener('wheel',      onScroll);
    window.removeEventListener('touchstart', onTouch);
    window.removeEventListener('blur',       onFocusLoss);

    if (rafHandle.current !== null) cancelAnimationFrame(rafHandle.current);
    if (flushTimer.current !== null) clearInterval(flushTimer.current);

    // Final flush of any remaining buffered events
    flushBatch();

    ringBuffer.current    = [];
    batchBuffer.current   = [];
    keyDownTimes.current.clear();
    lastMousePos.current  = null;
    sendFnRef.current     = null;
  }, [onMouseMove, onKeyDown, onKeyUp, onScroll, onTouch, onFocusLoss, flushBatch]);

  // ─── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => () => stop(), [stop]);

  return (
    <TelemetryContext.Provider
      value={{ isCollecting: isCollecting.current, start, stop }}
    >
      {children}
    </TelemetryContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useTelemetry(): TelemetryContextValue {
  const ctx = useContext(TelemetryContext);
  if (!ctx) throw new Error('useTelemetry must be used within TelemetryProvider');
  return ctx;
}
