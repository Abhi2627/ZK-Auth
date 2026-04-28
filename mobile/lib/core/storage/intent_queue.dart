/// Intent Queue — SQLite-backed pending-operation recovery for Flutter
///
/// Mirrors the web IndexedDB intent queue. On app startup, replays any
/// PENDING intents using the same UUID as the X-Idempotency-Key header,
/// which triggers the backend's idempotency cache and returns the cached
/// result rather than executing the handler a second time.
///
/// Dependencies:
///   sqflite: ^2.3.2
///   path: ^1.9.0
///
/// Add to pubspec.yaml:
///   sqflite: ^2.3.2
///   path: ^1.9.0

import 'dart:convert';
import 'package:sqflite/sqflite.dart';
import 'package:path/path.dart' as p;
import 'package:uuid/uuid.dart';

// ─── Types ────────────────────────────────────────────────────────────────────

enum IntentType {
  issueCredential,
  generateProof,
  submitPresentation,
  registerUser,
  recoverAccount,
}

enum IntentStatus { pending, completed, failed }

class Intent {
  final String       id;             // UUID — also the idempotency key
  final IntentType   type;
  final Map<String, dynamic> payload;
  final IntentStatus status;
  final int          createdAt;      // epoch ms
  final int          attempts;
  final dynamic      result;
  final String?      error;

  const Intent({
    required this.id,
    required this.type,
    required this.payload,
    required this.status,
    required this.createdAt,
    required this.attempts,
    this.result,
    this.error,
  });

  Map<String, dynamic> toRow() => {
    'id':         id,
    'type':       type.name,
    'payload':    jsonEncode(payload),
    'status':     status.name,
    'created_at': createdAt,
    'attempts':   attempts,
    'result':     result != null ? jsonEncode(result) : null,
    'error':      error,
  };

  factory Intent.fromRow(Map<String, dynamic> row) => Intent(
    id:         row['id'] as String,
    type:       IntentType.values.firstWhere((t) => t.name == row['type']),
    payload:    jsonDecode(row['payload'] as String) as Map<String, dynamic>,
    status:     IntentStatus.values.firstWhere((s) => s.name == row['status']),
    createdAt:  row['created_at'] as int,
    attempts:   row['attempts'] as int,
    result:     row['result'] != null ? jsonDecode(row['result'] as String) : null,
    error:      row['error'] as String?,
  );
}

// ─── Queue ────────────────────────────────────────────────────────────────────

class IntentQueueService {
  static const int _maxAttempts = 5;
  static const String _dbName   = 'zk_auth_intents.db';
  static const int    _version  = 1;

  Database? _db;
  final _uuid = const Uuid();

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  Future<void> init() async {
    final dbPath = p.join(await getDatabasesPath(), _dbName);
    _db = await openDatabase(
      dbPath,
      version: _version,
      onCreate: (db, version) async {
        await db.execute('''
          CREATE TABLE intents (
            id         TEXT PRIMARY KEY,
            type       TEXT NOT NULL,
            payload    TEXT NOT NULL,
            status     TEXT NOT NULL DEFAULT 'pending',
            created_at INTEGER NOT NULL,
            attempts   INTEGER NOT NULL DEFAULT 0,
            result     TEXT,
            error      TEXT
          )
        ''');
        await db.execute(
          'CREATE INDEX idx_intents_status ON intents(status)',
        );
      },
    );
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /// Persist a new PENDING intent. Returns the UUID (idempotency key).
  Future<String> enqueue(
    IntentType               type,
    Map<String, dynamic>     payload,
  ) async {
    _assertOpen();
    final intent = Intent(
      id:        _uuid.v4(),
      type:      type,
      payload:   payload,
      status:    IntentStatus.pending,
      createdAt: DateTime.now().millisecondsSinceEpoch,
      attempts:  0,
    );
    await _db!.insert('intents', intent.toRow());
    return intent.id;
  }

  /// Mark an intent as COMPLETED with the API result.
  Future<void> complete(String id, dynamic result) async {
    _assertOpen();
    await _db!.update(
      'intents',
      {
        'status': 'completed',
        'result': result != null ? jsonEncode(result) : null,
      },
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  /// Increment attempt count; mark as FAILED after maxAttempts.
  Future<void> fail(String id, String error) async {
    _assertOpen();
    final rows = await _db!.query(
      'intents', columns: ['attempts'], where: 'id = ?', whereArgs: [id],
    );
    if (rows.isEmpty) return;

    final attempts = (rows.first['attempts'] as int) + 1;
    await _db!.update(
      'intents',
      {
        'attempts': attempts,
        'error':    error,
        'status':   attempts >= _maxAttempts ? 'failed' : 'pending',
      },
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  /// Return all PENDING intents for replay on startup.
  Future<List<Intent>> getPending() async {
    _assertOpen();
    final rows = await _db!.query(
      'intents', where: 'status = ?', whereArgs: ['pending'],
      orderBy: 'created_at ASC',
    );
    return rows.map(Intent.fromRow).toList();
  }

  /// Replay all PENDING intents.
  ///
  /// [handler] receives the intent and should call the API with
  /// `intent.id` as the `X-Idempotency-Key` header.
  Future<({int replayed, int failed})> replayPending(
    Future<dynamic> Function(Intent) handler,
  ) async {
    final pending = await getPending();
    int replayed  = 0;
    int failedCount = 0;

    for (final intent in pending) {
      try {
        final result = await handler(intent);
        await complete(intent.id, result);
        replayed++;
      } catch (e) {
        await fail(intent.id, e.toString());
        failedCount++;
      }
    }

    return (replayed: replayed, failed: failedCount);
  }

  /// Delete COMPLETED intents older than [maxAge] (default 7 days).
  Future<int> prune([Duration maxAge = const Duration(days: 7)]) async {
    _assertOpen();
    final cutoff = DateTime.now()
        .subtract(maxAge)
        .millisecondsSinceEpoch;

    return _db!.delete(
      'intents',
      where: 'status = ? AND created_at < ?',
      whereArgs: ['completed', cutoff],
    );
  }

  Future<void> dispose() async => _db?.close();

  void _assertOpen() {
    if (_db == null) throw StateError('IntentQueueService not initialised — call init() first');
  }
}

/// Global singleton
final intentQueue = IntentQueueService();
