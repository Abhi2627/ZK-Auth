/// Mobile Behavioral Event Collector
///
/// Captures touch pressure, contact size, swipe velocity, gyroscope,
/// and accelerometer data and maps them into the BehaviorEvent structure.
///
/// ─── Hardware channels ──────────────────────────────────────────────────────
///   PointerEvent (Flutter framework):
///     pressure       — normalised touch force [0.0, 1.0]
///     size           — contact area (not transmitted, used for anomaly detection)
///     delta          — pointer movement vector between frames
///
///   sensors_plus:
///     GyroscopeEvent — rotation rate (rad/s) on x, y, z axes
///     AccelerometerEvent — linear acceleration (m/s²)
///
///   Both sensor streams run at ~50Hz on Android/iOS.
///   We sample them at 10Hz (every 100ms) to reduce data volume while
///   retaining the behavioural signal.
///
/// ─── Feature vector additions vs web client ───────────────────────────────
///   Mobile adds two features not present in the web telemetry:
///     - touch_pressure  (already in BehaviorEvent structure)
///     - gyro_magnitude  (derived: √(x²+y²+z²)) → encoded in scroll_delta
///       field as a proxy (Phase 8 would add a dedicated field)
///
/// ─── UI thread protection ─────────────────────────────────────────────────
///   PointerEvent callbacks fire on the UI thread (unavoidable for input).
///   Processing is O(1): compute delta, push to buffer. Feature engineering
///   (velocity, gyro sampling) runs in a periodic Timer callback that fires
///   every DRAIN_INTERVAL_MS on the Dart event loop between frames.
///
///   Sensor streams are subscribed on the event loop thread (not a separate
///   thread in Dart's single-threaded model) but are gated through a
///   sample-rate limiter to prevent flooding.

import 'dart:async';
import 'dart:math' as math;

import 'package:sensors_plus/sensors_plus.dart';

// ─── BehaviorEvent model (matches packages/types/src/risk.types.ts) ───────────

class MobileBehaviorEvent {
  final String  sessionId;
  final int     timestampMs;
  final String  eventType;
  final double? mouseVelocity;   // swipe velocity px/ms
  final int?    keyDwellMs;
  final double? scrollDelta;     // gyro magnitude proxy
  final double? touchPressure;
  final String? pageContext;
  final int     sequenceNum;

  const MobileBehaviorEvent({
    required this.sessionId,
    required this.timestampMs,
    required this.eventType,
    this.mouseVelocity,
    this.keyDwellMs,
    this.scrollDelta,
    this.touchPressure,
    this.pageContext,
    required this.sequenceNum,
  });

  Map<String, dynamic> toJson() => {
    'session_id':    sessionId,
    'timestamp_ms':  timestampMs,
    'event_type':    eventType,
    if (mouseVelocity != null)  'mouse_velocity':  mouseVelocity,
    if (keyDwellMs    != null)  'key_dwell_ms':    keyDwellMs,
    if (scrollDelta   != null)  'scroll_delta':    scrollDelta,
    if (touchPressure != null)  'touch_pressure':  touchPressure,
    if (pageContext   != null)  'page_context':    pageContext,
    'sequence_num':  sequenceNum,
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const int    _kDrainIntervalMs    = 100;   // drain buffer every 100ms
const int    _kFlushIntervalMs    = 500;   // flush to WS every 500ms
const int    _kMaxBufferSize      = 200;   // ring buffer cap
const double _kMaxSwipeVelocity   = 10.0;  // px/ms clip
const Duration _kGyroSampleRate   = Duration(milliseconds: 100);

// ─── Collector ────────────────────────────────────────────────────────────────

class EventCollector {
  final void Function(MobileBehaviorEvent) onEvent;

  String _sessionId   = '';
  int    _seqNum      = 0;
  bool   _collecting  = false;

  // Raw pointer ring buffer
  final List<_RawPointerSample> _pointerBuffer = [];
  _RawPointerSample? _lastPointerSample;

  // Gyroscope state (sampled at _kGyroSampleRate)
  GyroscopeEvent? _lastGyro;
  DateTime        _lastGyroSampleTime = DateTime.fromMillisecondsSinceEpoch(0);
  StreamSubscription<GyroscopeEvent>? _gyroSub;

  // Timers
  Timer? _drainTimer;
  Timer? _flushTimer;

  EventCollector({required this.onEvent});

  // ─── Public API ────────────────────────────────────────────────────────────

  void start(String sessionId) {
    if (_collecting) return;
    _sessionId  = sessionId;
    _seqNum     = 0;
    _collecting = true;

    // Subscribe to gyroscope
    _gyroSub = gyroscopeEventStream(samplingPeriod: SensorInterval.normalInterval)
        .listen(_onGyroEvent);

    // Drain timer: process raw buffer every 100ms
    _drainTimer = Timer.periodic(
      Duration(milliseconds: _kDrainIntervalMs),
      (_) => _drain(),
    );
  }

  void stop() {
    if (!_collecting) return;
    _collecting = false;
    _gyroSub?.cancel();
    _drainTimer?.cancel();
    _flushTimer?.cancel();
    _pointerBuffer.clear();
    _lastPointerSample = null;
    _lastGyro = null;
  }

  /// Called from Flutter's Listener widget onPointerMove / onPointerDown.
  void recordPointerEvent({
    required String type,
    required double x,
    required double y,
    required double pressure,
    required int    timestampMs,
  }) {
    if (!_collecting) return;
    if (_pointerBuffer.length >= _kMaxBufferSize) {
      _pointerBuffer.removeAt(0);
    }
    _pointerBuffer.add(_RawPointerSample(
      type:        type,
      x:           x,
      y:           y,
      pressure:    pressure,
      timestampMs: timestampMs,
    ));
  }

  // ─── Private: gyroscope handler ───────────────────────────────────────────

  void _onGyroEvent(GyroscopeEvent event) {
    final now = DateTime.now();
    if (now.difference(_lastGyroSampleTime) < _kGyroSampleRate) return;
    _lastGyroSampleTime = now;
    _lastGyro = event;
  }

  // ─── Private: drain raw buffer ────────────────────────────────────────────

  void _drain() {
    if (_pointerBuffer.isEmpty) return;
    final raw = List<_RawPointerSample>.from(_pointerBuffer);
    _pointerBuffer.clear();

    for (final sample in raw) {
      double? velocity;

      if (sample.type == 'MOUSE_MOVE' && _lastPointerSample != null) {
        final dx = sample.x - _lastPointerSample!.x;
        final dy = sample.y - _lastPointerSample!.y;
        final dt = sample.timestampMs - _lastPointerSample!.timestampMs;
        if (dt > 0) {
          final dist = math.sqrt(dx * dx + dy * dy);
          velocity = (dist / dt).clamp(0.0, _kMaxSwipeVelocity);
        }
      }
      _lastPointerSample = sample;

      // Encode gyro magnitude into scrollDelta field
      double? gyroMag;
      if (_lastGyro != null) {
        final g = _lastGyro!;
        gyroMag = math.sqrt(g.x * g.x + g.y * g.y + g.z * g.z);
      }

      final event = MobileBehaviorEvent(
        sessionId:    _sessionId,
        timestampMs:  sample.timestampMs,
        eventType:    sample.type,
        mouseVelocity: velocity,
        scrollDelta:   gyroMag,
        touchPressure: sample.pressure > 0 ? sample.pressure : null,
        pageContext:   null, // set by caller for current route
        sequenceNum:   _seqNum++,
      );

      onEvent(event);
    }
  }
}

// ─── Internal data class ──────────────────────────────────────────────────────

class _RawPointerSample {
  final String type;
  final double x;
  final double y;
  final double pressure;
  final int    timestampMs;

  const _RawPointerSample({
    required this.type,
    required this.x,
    required this.y,
    required this.pressure,
    required this.timestampMs,
  });
}
