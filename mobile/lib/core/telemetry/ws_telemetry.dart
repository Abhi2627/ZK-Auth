/// WebSocket Telemetry Service
///
/// Manages the authenticated WebSocket connection to the API gateway
/// and streams BehaviorEvents + handles incoming risk score messages.
///
/// Reconnection strategy: exponential backoff (1s, 2s, 4s…, max 30s).
/// Token passed as query param (WS upgrade handshake has no auth headers).

import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'event_collector.dart';

// ─── Message types ────────────────────────────────────────────────────────────

enum WsMessageType {
  behaviorEvent,
  riskUpdate,
  stepUpRequired,
  stepUpResolved,
  sessionTerminated,
  ping,
  pong,
}

class WsIncomingMessage {
  final String type;
  final dynamic payload;
  final int ts;

  WsIncomingMessage({
    required this.type,
    required this.payload,
    required this.ts,
  });

  factory WsIncomingMessage.fromJson(Map<String, dynamic> json) =>
      WsIncomingMessage(
        type:    json['type']    as String,
        payload: json['payload'],
        ts:      json['ts']      as int? ?? 0,
      );
}

// ─── Service ──────────────────────────────────────────────────────────────────

class WsTelemetryService {
  static const String _wsBase = String.fromEnvironment(
    'WS_BASE_URL',
    defaultValue: 'ws://localhost:3001/api/v1/session/telemetry',
  );

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _sub;
  Timer? _reconnectTimer;
  Timer? _pingTimer;

  int     _retryCount = 0;
  bool    _intentionalClose = false;
  String? _accessToken;
  String? _sessionId;

  // Flush buffer
  final List<Map<String, dynamic>> _outBuffer = [];
  static const int _kFlushIntervalMs  = 500;
  static const int _kMaxBatchSize     = 20;
  Timer? _flushTimer;

  // Incoming message stream
  final StreamController<WsIncomingMessage> _incomingController =
      StreamController<WsIncomingMessage>.broadcast();

  Stream<WsIncomingMessage> get incomingMessages => _incomingController.stream;

  // ─── Connection management ─────────────────────────────────────────────────

  void connect({required String accessToken, required String sessionId}) {
    _accessToken      = accessToken;
    _sessionId        = sessionId;
    _intentionalClose = false;
    _retryCount       = 0;
    _openConnection();
  }

  void disconnect() {
    _intentionalClose = true;
    _cleanup();
  }

  void _openConnection() {
    if (_accessToken == null) return;

    final uri = Uri.parse(
      '$_wsBase?token=${Uri.encodeComponent(_accessToken!)}',
    );

    try {
      _channel = IOWebSocketChannel.connect(uri,
          connectTimeout: const Duration(seconds: 10));
    } catch (_) {
      _scheduleReconnect();
      return;
    }

    _sub = _channel!.stream.listen(
      _onMessage,
      onDone: _onClose,
      onError: (_) => _onClose(),
      cancelOnError: false,
    );

    _retryCount = 0;

    // Keepalive ping every 30s
    _pingTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      _sendRaw({'type': 'PING', 'payload': {}, 'ts': _nowMs()});
    });

    // Flush timer
    _flushTimer = Timer.periodic(
      Duration(milliseconds: _kFlushIntervalMs),
      (_) => _flush(),
    );
  }

  void _onMessage(dynamic raw) {
    try {
      final Map<String, dynamic> json = jsonDecode(raw as String);
      final msg = WsIncomingMessage.fromJson(json);
      _incomingController.add(msg);
    } catch (_) {}
  }

  void _onClose() {
    _cleanup();
    if (!_intentionalClose) _scheduleReconnect();
  }

  void _scheduleReconnect() {
    final delay = Duration(
      milliseconds: (_retryCount < 6)
          ? (1000 * (1 << _retryCount)).clamp(0, 30000)
          : 30000,
    );
    _retryCount++;
    _reconnectTimer = Timer(delay, _openConnection);
  }

  void _cleanup() {
    _sub?.cancel();
    _channel?.sink.close();
    _pingTimer?.cancel();
    _flushTimer?.cancel();
    _reconnectTimer?.cancel();
    _channel = null;
    _sub     = null;
  }

  // ─── Event buffering & flush ───────────────────────────────────────────────

  void bufferEvent(MobileBehaviorEvent event) {
    if (_outBuffer.length >= 200) _outBuffer.removeAt(0);
    _outBuffer.add({
      'type':    'BEHAVIOR_EVENT',
      'payload': event.toJson(),
      'ts':      _nowMs(),
    });
    if (_outBuffer.length >= _kMaxBatchSize) _flush();
  }

  void _flush() {
    if (_outBuffer.isEmpty || _channel == null) return;
    final batch = List<Map<String, dynamic>>.from(_outBuffer);
    _outBuffer.clear();
    for (final msg in batch) {
      _sendRaw(msg);
    }
  }

  void _sendRaw(Map<String, dynamic> msg) {
    try {
      _channel?.sink.add(jsonEncode(msg));
    } catch (_) {}
  }

  int _nowMs() => DateTime.now().millisecondsSinceEpoch;

  void dispose() {
    disconnect();
    _incomingController.close();
  }
}
