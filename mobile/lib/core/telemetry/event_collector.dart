/// Mobile Behavioral Event Collector (stub — sensors_plus removed for now)
/// Full LSTM behavioral analysis is Phase 11.
/// For now we collect only touch/pointer events without gyroscope.

import 'dart:async';
import 'dart:math' as math;

class MobileBehaviorEvent {
  final String  sessionId;
  final int     timestampMs;
  final String  eventType;
  final double? mouseVelocity;
  final double? touchPressure;
  final int     sequenceNum;

  const MobileBehaviorEvent({
    required this.sessionId,
    required this.timestampMs,
    required this.eventType,
    this.mouseVelocity,
    this.touchPressure,
    required this.sequenceNum,
  });

  Map<String, dynamic> toJson() => {
    'session_id':   sessionId,
    'timestamp_ms': timestampMs,
    'event_type':   eventType,
    if (mouseVelocity != null) 'mouse_velocity': mouseVelocity,
    if (touchPressure != null) 'touch_pressure': touchPressure,
    'sequence_num': sequenceNum,
  };
}

class EventCollector {
  final void Function(MobileBehaviorEvent) onEvent;

  String _sessionId  = '';
  int    _seqNum     = 0;
  bool   _collecting = false;

  final List<_Sample> _buffer = [];
  _Sample? _last;
  Timer?   _timer;

  EventCollector({required this.onEvent});

  void start(String sessionId) {
    if (_collecting) return;
    _sessionId  = sessionId;
    _seqNum     = 0;
    _collecting = true;
    _timer = Timer.periodic(const Duration(milliseconds: 100), (_) => _drain());
  }

  void stop() {
    _collecting = false;
    _timer?.cancel();
    _buffer.clear();
    _last = null;
  }

  void recordPointerEvent({
    required String type,
    required double x,
    required double y,
    required double pressure,
    required int    timestampMs,
  }) {
    if (!_collecting || _buffer.length >= 200) return;
    _buffer.add(_Sample(type: type, x: x, y: y, pressure: pressure, ts: timestampMs));
  }

  void _drain() {
    if (_buffer.isEmpty) return;
    final raw = List<_Sample>.from(_buffer);
    _buffer.clear();

    for (final s in raw) {
      double? vel;
      if (_last != null && s.type == 'MOUSE_MOVE') {
        final dx = s.x - _last!.x, dy = s.y - _last!.y;
        final dt = s.ts - _last!.ts;
        if (dt > 0) vel = (math.sqrt(dx * dx + dy * dy) / dt).clamp(0.0, 10.0);
      }
      _last = s;
      onEvent(MobileBehaviorEvent(
        sessionId:    _sessionId,
        timestampMs:  s.ts,
        eventType:    s.type,
        mouseVelocity: vel,
        touchPressure: s.pressure > 0 ? s.pressure : null,
        sequenceNum:   _seqNum++,
      ));
    }
  }
}

class _Sample {
  final String type;
  final double x, y, pressure;
  final int    ts;
  const _Sample({required this.type, required this.x, required this.y, required this.pressure, required this.ts});
}
