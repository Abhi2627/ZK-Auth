/// ConnectedDevicesScreen — Flutter session/device management UI.
///
/// Lists all active sessions (from GET /session/devices) and allows
/// the user to revoke individual sessions or all sessions at once.
///
/// Each list item uses AnimatedList for insertion/removal animations —
/// the revoke action triggers a slide-and-fade removal with
/// SizeTransition + FadeTransition combined, mirroring the
/// framer-motion exit animation in the Next.js implementation.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/http_client.dart';
import '../../core/storage/secure_storage.dart';

// ─── Model ────────────────────────────────────────────────────────────────────

class DeviceSession {
  final String  id;
  final String? deviceLabel;
  final String? ipAddress;
  final String  riskLevel;
  final String  createdAt;
  final String  lastActiveAt;
  final bool    isCurrent;

  const DeviceSession({
    required this.id,
    required this.deviceLabel,
    required this.ipAddress,
    required this.riskLevel,
    required this.createdAt,
    required this.lastActiveAt,
    required this.isCurrent,
  });

  factory DeviceSession.fromJson(Map<String, dynamic> json) => DeviceSession(
    id:           json['id']             as String,
    deviceLabel:  json['device_label']   as String?,
    ipAddress:    json['ip_address']     as String?,
    riskLevel:    json['risk_level']     as String? ?? 'LOW',
    createdAt:    json['created_at']     as String,
    lastActiveAt: json['last_active_at'] as String,
    isCurrent:    json['is_current']     as bool? ?? false,
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

class ConnectedDevicesScreen extends StatefulWidget {
  final ZkAuthHttpClient client;
  final SecureStorage    storage;

  const ConnectedDevicesScreen({
    super.key,
    required this.client,
    required this.storage,
  });

  @override
  State<ConnectedDevicesScreen> createState() => _ConnectedDevicesScreenState();
}

class _ConnectedDevicesScreenState extends State<ConnectedDevicesScreen> {
  final GlobalKey<AnimatedListState> _listKey = GlobalKey<AnimatedListState>();
  final List<DeviceSession> _sessions = [];

  bool    _loading  = true;
  String? _error;
  String? _revoking;

  @override
  void initState() {
    super.initState();
    _loadSessions();
  }

  // ─── Data ──────────────────────────────────────────────────────────────────

  Future<void> _loadSessions() async {
    setState(() { _loading = true; _error = null; });
    try {
      final res = await widget.client.dio.get<Map<String, dynamic>>('/session/devices');
      final list = (res.data!['sessions'] as List<dynamic>)
          .map((e) => DeviceSession.fromJson(e as Map<String, dynamic>))
          .toList();

      // Clear AnimatedList then repopulate
      for (var i = _sessions.length - 1; i >= 0; i--) {
        _sessions.removeAt(i);
      }
      setState(() {});

      for (final session in list) {
        _sessions.add(session);
        _listKey.currentState?.insertItem(_sessions.length - 1);
      }
    } on ZkAuthApiException catch (e) {
      setState(() { _error = e.message; });
    } catch (e) {
      setState(() { _error = 'Failed to load sessions'; });
    } finally {
      setState(() { _loading = false; });
    }
  }

  Future<void> _revoke(String sessionId, bool isCurrent) async {
    setState(() { _revoking = sessionId; });
    try {
      if (isCurrent) {
        await widget.client.dio.post<void>('/auth/logout', data: {'all_devices': false});
        await widget.storage.clearSession();
        if (mounted) context.go('/login');
        return;
      }

      await widget.client.dio.delete<void>('/session/$sessionId');

      final idx = _sessions.indexWhere((s) => s.id == sessionId);
      if (idx >= 0) {
        final removed = _sessions.removeAt(idx);
        _listKey.currentState?.removeItem(
          idx,
          (context, animation) => _SessionCard(
            session:  removed,
            revoking: false,
            onRevoke: (_) {},
            animation: animation,
          ),
          duration: const Duration(milliseconds: 250),
        );
      }
    } on ZkAuthApiException catch (e) {
      setState(() { _error = e.message; });
    } finally {
      setState(() { _revoking = null; });
    }
  }

  Future<void> _revokeAll() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: const Color(0xFF161B22),
        title: const Text('Sign out all devices?',
            style: TextStyle(color: Color(0xFFE6EDF3))),
        content: const Text(
          'You will be signed out from every device except this one.',
          style: TextStyle(color: Color(0xFF8B949E)),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Sign out all', style: TextStyle(color: Color(0xFFF85149))),
          ),
        ],
      ),
    );
    if (confirmed != true) return;

    setState(() { _revoking = 'all'; });
    try {
      await widget.client.dio.delete<void>('/session/all');
      await _loadSessions();
    } finally {
      setState(() { _revoking = null; });
    }
  }

  // ─── Build ─────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0D1117),
      appBar: AppBar(
        backgroundColor: const Color(0xFF161B22),
        foregroundColor: const Color(0xFFE6EDF3),
        title: const Text('Connected Devices'),
        actions: [
          IconButton(
            icon: _loading
                ? const SizedBox(
                    width: 20, height: 20,
                    child: CircularProgressIndicator(
                      strokeWidth: 2, color: Color(0xFF8B949E),
                    ),
                  )
                : const Icon(Icons.refresh),
            onPressed: _loading ? null : _loadSessions,
          ),
        ],
      ),
      body: Column(
        children: [
          if (_error != null)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              color: const Color(0xFF450A0A),
              child: Text(_error!, style: const TextStyle(color: Color(0xFFF87171), fontSize: 13)),
            ),

          Expanded(
            child: _sessions.isEmpty && !_loading
                ? const Center(
                    child: Text('No active sessions.',
                        style: TextStyle(color: Color(0xFF8B949E))),
                  )
                : AnimatedList(
                    key: _listKey,
                    padding: const EdgeInsets.all(16),
                    initialItemCount: _sessions.length,
                    itemBuilder: (context, index, animation) {
                      if (index >= _sessions.length) return const SizedBox.shrink();
                      final session = _sessions[index];
                      return _SessionCard(
                        session:   session,
                        revoking:  _revoking == session.id,
                        onRevoke:  (id) => _revoke(id, session.isCurrent),
                        animation: animation,
                      );
                    },
                  ),
          ),

          // Revoke all button
          if (_sessions.where((s) => !s.isCurrent).isNotEmpty)
            SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                child: OutlinedButton(
                  style: OutlinedButton.styleFrom(
                    foregroundColor: const Color(0xFFF85149),
                    side: const BorderSide(color: Color(0xFF30363D)),
                    minimumSize: const Size.fromHeight(44),
                  ),
                  onPressed: _revoking == 'all' ? null : _revokeAll,
                  child: _revoking == 'all'
                      ? const Text('Signing out…')
                      : const Text('Sign out all other devices'),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

// ─── Session card ─────────────────────────────────────────────────────────────

class _SessionCard extends StatelessWidget {
  final DeviceSession session;
  final bool          revoking;
  final void Function(String) onRevoke;
  final Animation<double>     animation;

  const _SessionCard({
    required this.session,
    required this.revoking,
    required this.onRevoke,
    required this.animation,
  });

  @override
  Widget build(BuildContext context) {
    return SizeTransition(
      sizeFactor: CurvedAnimation(parent: animation, curve: Curves.easeOut),
      child: FadeTransition(
        opacity: animation,
        child: Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Container(
            decoration: BoxDecoration(
              color:  session.isCurrent
                  ? const Color(0xFF0D2149)
                  : const Color(0xFF161B22),
              border: Border.all(
                color: session.isCurrent
                    ? const Color(0xFF388BFD)
                    : const Color(0xFF30363D),
              ),
              borderRadius: BorderRadius.circular(8),
            ),
            padding: const EdgeInsets.all(14),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Device icon
                Text(_deviceIcon(session.deviceLabel), style: const TextStyle(fontSize: 24)),
                const SizedBox(width: 12),

                // Info
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            child: Text(
                              session.deviceLabel ?? 'Unknown Device',
                              style: const TextStyle(
                                color: Color(0xFFE6EDF3),
                                fontWeight: FontWeight.w600,
                                fontSize: 14,
                              ),
                            ),
                          ),
                          if (session.isCurrent) ...[
                            const SizedBox(width: 6),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                              decoration: BoxDecoration(
                                color: const Color(0xFF1F6FEB),
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: const Text('This device',
                                  style: TextStyle(color: Colors.white, fontSize: 10)),
                            ),
                          ],
                        ],
                      ),
                      const SizedBox(height: 3),
                      Text(
                        '${session.ipAddress ?? "Unknown IP"} · ${_relativeTime(session.lastActiveAt)}',
                        style: const TextStyle(color: Color(0xFF8B949E), fontSize: 12),
                      ),
                      const SizedBox(height: 4),
                      _RiskChip(level: session.riskLevel),
                    ],
                  ),
                ),

                // Revoke button
                const SizedBox(width: 8),
                OutlinedButton(
                  style: OutlinedButton.styleFrom(
                    foregroundColor: session.isCurrent
                        ? const Color(0xFFF85149)
                        : const Color(0xFF8B949E),
                    side: BorderSide(
                      color: session.isCurrent
                          ? const Color(0xFFDA3633)
                          : const Color(0xFF6E7681),
                    ),
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                    minimumSize: Size.zero,
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  onPressed: revoking ? null : () => onRevoke(session.id),
                  child: revoking
                      ? const SizedBox(width: 14, height: 14,
                          child: CircularProgressIndicator(strokeWidth: 2))
                      : Text(
                          session.isCurrent ? 'Sign out' : 'Revoke',
                          style: const TextStyle(fontSize: 12),
                        ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  String _deviceIcon(String? label) {
    if (label == null) return '💻';
    final l = label.toLowerCase();
    if (l.contains('iphone') || l.contains('android')) return '📱';
    return '💻';
  }

  String _relativeTime(String iso) {
    final delta = DateTime.now().difference(DateTime.parse(iso));
    if (delta.inSeconds < 60)  return 'just now';
    if (delta.inMinutes < 60)  return '${delta.inMinutes}m ago';
    if (delta.inHours < 24)    return '${delta.inHours}h ago';
    return '${delta.inDays}d ago';
  }
}

class _RiskChip extends StatelessWidget {
  final String level;
  const _RiskChip({required this.level});

  @override
  Widget build(BuildContext context) {
    final colours = <String, Color>{
      'LOW':      const Color(0xFF4ADE80),
      'MEDIUM':   const Color(0xFFFB923C),
      'HIGH':     const Color(0xFFF87171),
      'CRITICAL': const Color(0xFFE879F9),
    };
    final bg = <String, Color>{
      'LOW':      const Color(0xFF052E16),
      'MEDIUM':   const Color(0xFF451A03),
      'HIGH':     const Color(0xFF450A0A),
      'CRITICAL': const Color(0xFF3B0764),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color:        bg[level] ?? const Color(0xFF052E16),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        level,
        style: TextStyle(
          color:      colours[level] ?? const Color(0xFF4ADE80),
          fontSize:   10,
          fontWeight: FontWeight.w600,
          letterSpacing: 0.4,
        ),
      ),
    );
  }
}
