import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:dio/dio.dart';
import '../../core/config/app_config.dart';

class ScannerScreen extends StatefulWidget {
  const ScannerScreen({super.key});

  @override
  State<ScannerScreen> createState() => _ScannerScreenState();
}

class _ScannerScreenState extends State<ScannerScreen> {
  final MobileScannerController _ctrl = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
  );

  bool _scanning  = true;
  bool _verifying = false;
  Map<String, dynamic>? _result;
  String? _scannedData;
  String? _error;

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _onDetect(BarcodeCapture capture) async {
    if (!_scanning) return;
    final raw = capture.barcodes.firstOrNull?.rawValue;
    if (raw == null) return;

    setState(() {
      _scanning    = false;
      _verifying   = true;
      _scannedData = raw;
      _error       = null;
      _result      = null;
    });

    await _verify(raw);
  }

  Future<void> _verify(String raw) async {
    try {
      Map<String, dynamic> parsed;
      try {
        parsed = jsonDecode(raw) as Map<String, dynamic>;
      } catch (_) {
        setState(() {
          _verifying = false;
          _error     = 'Not a ZK-Auth credential QR.';
        });
        return;
      }

      final docId  = parsed['id']?.toString() ?? '';
      final fp     = parsed['fp']?.toString() ?? '';
      final type   = parsed['type']?.toString() ?? 'Unknown';
      final verifyUrl = parsed['verify']?.toString() ?? '';

      // Extract credential_id from verify URL or use id field directly
      String credentialId = docId;
      if (verifyUrl.isNotEmpty) {
        final uri = Uri.tryParse(verifyUrl);
        if (uri != null && uri.pathSegments.isNotEmpty) {
          credentialId = uri.pathSegments.last;
        }
      }

      final dio = Dio(BaseOptions(
        connectTimeout: const Duration(seconds: 8),
        receiveTimeout: const Duration(seconds: 8),
      ));

      // Call the verify-doc endpoint to get real document details
      final apiBase = 'http://${AppConfig.apiHost}:${AppConfig.apiPort}';
      final resp = await dio.get<Map<String, dynamic>>(
        '$apiBase/api/verifier/verify-doc/$credentialId',
      );

      final data = resp.data!;
      final verified = data['verified'] as bool? ?? false;

      setState(() {
        _verifying = false;
        _result    = {
          'verified':       verified,
          'authentic':      data['authentic'] ?? false,
          'doc_id':         credentialId,
          'doc_type':       data['document_type'] ?? type,
          'doc_name':       data['document_name'] ?? type,
          'fingerprint':    fp,
          'issuer_name':    data['issuer_name'] ?? data['issuer_did'] ?? 'Unknown',
          'issuer_did':     data['issuer_did'] ?? '',
          'holder_did':     data['holder_did'] ?? '',
          'issued_at':      data['issued_at'] ?? parsed['issued'] ?? '',
          'expires_at':     data['expires_at'] ?? '',
          'status':         data['status'] ?? 'UNKNOWN',
          'merkle_root':    data['merkle_root'] ?? (parsed['root'] ?? ''),
          'attributes':     data['attribute_schema'] ?? [],
          'error':          data['error'],
          'privacy_notice': data['privacy_notice'] ?? '',
        };
      });
    } on DioException catch (e) {
      String message;
      if (e.type == DioExceptionType.connectionTimeout ||
          e.type == DioExceptionType.connectionError) {
        message =
            'Could not reach the backend at ${AppConfig.apiHost}:${AppConfig.apiPort}.\n\n'
            'Check:\n'
            '• Backend is running (./start.sh on your Mac)\n'
            '• Phone and Mac are on the same Wi-Fi network\n'
            '• App was launched with the correct IP, e.g.\n'
            '  flutter run --dart-define=API_HOST=<your-mac-lan-ip>\n'
            '  (NOT "localhost" — that means the phone itself, not your Mac)';
      } else if (e.response?.statusCode != null) {
        message = 'Backend returned ${e.response!.statusCode}: ${e.message}';
      } else {
        message = 'Backend error: ${e.message}';
      }
      setState(() {
        _verifying = false;
        _error     = message;
      });
    } catch (e) {
      setState(() {
        _verifying = false;
        _error     = e.toString();
      });
    }
  }

  void _reset() {
    setState(() {
      _scanning  = true;
      _verifying = false;
      _result    = null;
      _scannedData = null;
      _error     = null;
    });
    _ctrl.start();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF010409),
      appBar: AppBar(
        title: const Text('Scan & Verify'),
        actions: [
          if (!_scanning)
            TextButton(
              onPressed: _reset,
              child: const Text('Scan Again', style: TextStyle(color: Color(0xFF388BFD))),
            ),
        ],
      ),
      body: _verifying
          ? _buildVerifying()
          : _result != null
            ? _buildResult(_result!)
            : _error != null
              ? _buildError()
              : _buildScanner(),
    );
  }

  Widget _buildScanner() => Stack(
    children: [
      MobileScanner(controller: _ctrl, onDetect: _onDetect),

      // Overlay
      CustomPaint(
        painter: _ScanOverlayPainter(),
        child: Container(),
      ),

      // Instructions
      Positioned(
        bottom: 40,
        left: 20,
        right: 20,
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color:        Colors.black.withAlpha(180),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            children: const [
              Text('📷  Point at a ZK-Auth credential QR', textAlign: TextAlign.center,
                style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 14)),
              SizedBox(height: 6),
              Text('Works with QR codes from:\n• MANIT Issuer Portal\n• Mobile Document Vault',
                textAlign: TextAlign.center,
                style: TextStyle(color: Color(0xFF8B949E), fontSize: 12, height: 1.4)),
            ],
          ),
        ),
      ),
    ],
  );

  Widget _buildVerifying() => Center(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const CircularProgressIndicator(color: Color(0xFF388BFD), strokeWidth: 3),
        const SizedBox(height: 20),
        const Text('Verifying credential…', style: TextStyle(
          color: Color(0xFFE6EDF3), fontSize: 15, fontWeight: FontWeight.w600,
        )),
        const SizedBox(height: 8),
        const Text('Checking against issuer backend', style: TextStyle(
          color: Color(0xFF8B949E), fontSize: 12,
        )),
      ],
    ),
  );

  Widget _buildResult(Map<String, dynamic> result) {
    final verified  = result['verified'] as bool? ?? false;
    final authentic = result['authentic'] as bool? ?? false;
    final error     = result['error']?.toString();
    final status    = result['status']?.toString() ?? 'UNKNOWN';
    final attrs     = result['attributes'];
    final attrList  = attrs is List ? attrs.map((e) => e.toString()).toList() : <String>[];

    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        children: [
          // Result banner
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              gradient: LinearGradient(
                colors: verified
                    ? [const Color(0xFF0A1D0F), const Color(0xFF052E16)]
                    : [const Color(0xFF450A0A), const Color(0xFF1A0505)],
              ),
              borderRadius: BorderRadius.circular(14),
              border: Border.all(
                color: verified ? const Color(0xFF238636) : const Color(0xFF6E1F1F),
                width: 2,
              ),
            ),
            child: Column(
              children: [
                Text(verified ? '\u2705' : '\u274c',
                    style: const TextStyle(fontSize: 52)),
                const SizedBox(height: 12),
                Text(
                  verified ? 'Document Verified' : 'Document Not Found',
                  style: TextStyle(
                    color:      verified ? const Color(0xFF4ADE80) : const Color(0xFFF87171),
                    fontSize:   22,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  verified
                      ? 'ZK-Auth cryptographic verification passed'
                      : (error ?? 'This document was not issued by the registered issuer'),
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color:    verified ? const Color(0xFF3FB950) : const Color(0xFFF87171),
                    fontSize: 13,
                  ),
                ),
              ],
            ),
          ),

          if (verified) ...[  
            const SizedBox(height: 16),

            // Document info card
            _InfoCard(title: '\ud83d\udcc4 Document Details', rows: [
              ['Document Name',  result['doc_name']?.toString() ?? '\u2014'],
              ['Document Type',  result['doc_type']?.toString() ?? '\u2014'],
              ['Credential ID',  (result['doc_id']?.toString() ?? '\u2014').length > 12
                  ? '${result["doc_id"].toString().substring(0, 12)}\u2026'
                  : result['doc_id']?.toString() ?? '\u2014'],
              ['Status',        status],
              ['Issued Date',   _formatDate(result['issued_at']?.toString() ?? '')],
              ['Expires',       _formatDate(result['expires_at']?.toString() ?? '')],
            ]),

            const SizedBox(height: 12),

            // Issuer info card
            _InfoCard(title: '\ud83c\udfe6 Issuer Details', rows: [
              ['Issuer Name',  result['issuer_name']?.toString() ?? '\u2014'],
              ['Issuer DID',   _truncate(result['issuer_did']?.toString() ?? '')],
              ['Holder DID',   _truncate(result['holder_did']?.toString() ?? '')],
              ['Merkle Root',  result['merkle_root']?.toString() ?? '\u2014'],
              ['Fingerprint',  result['fingerprint']?.toString() ?? '\u2014'],
            ]),

            if (attrList.isNotEmpty) ...[  
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: const Color(0xFF0D1117),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: const Color(0xFF21262D)),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('\ud83d\udd10 Committed Attributes (names only \u2014 no values)',
                        style: TextStyle(
                          color: Color(0xFF8B949E),
                          fontSize: 12,
                          fontWeight: FontWeight.w700,
                        )),
                    const SizedBox(height: 10),
                    Wrap(
                      spacing: 8, runSpacing: 6,
                      children: attrList.map((a) => Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                        decoration: BoxDecoration(
                          color: const Color(0xFF0D2149),
                          borderRadius: BorderRadius.circular(6),
                          border: Border.all(color: const Color(0xFF1F6FEB44)),
                        ),
                        child: Text(a, style: const TextStyle(
                          color: Color(0xFF79C0FF), fontSize: 11, fontFamily: 'monospace',
                        )),
                      )).toList(),
                    ),
                  ],
                ),
              ),
            ],

            const SizedBox(height: 12),

            // Privacy notice
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: const Color(0xFF0D1117),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: const Color(0xFF21262D)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('\ud83d\udee1  Privacy Guarantee',
                      style: TextStyle(
                        color: Color(0xFF8B949E),
                        fontWeight: FontWeight.w700,
                        fontSize: 12,
                      )),
                  const SizedBox(height: 8),
                  Text(
                    result['privacy_notice']?.toString() ??
                        'No PII was retrieved or shared during this verification.',
                    style: const TextStyle(
                      color: Color(0xFFC9D1D9), fontSize: 12, height: 1.5,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }

  String _formatDate(String iso) {
    if (iso.isEmpty) return '\u2014';
    try {
      final d = DateTime.parse(iso);
      return '${d.day.toString().padLeft(2,'0')}/${d.month.toString().padLeft(2,'0')}/${d.year}';
    } catch (_) { return iso; }
  }

  String _truncate(String s) {
    if (s.length <= 20) return s;
    return '${s.substring(0, 10)}\u2026${s.substring(s.length - 8)}';
  }

  Widget _buildError() => Center(
    child: Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text('❌', style: TextStyle(fontSize: 52)),
          const SizedBox(height: 16),
          const Text('Verification Failed', style: TextStyle(
            color: Color(0xFFF87171), fontSize: 18, fontWeight: FontWeight.w700,
          )),
          const SizedBox(height: 8),
          Text(_error ?? 'Unknown error', textAlign: TextAlign.center,
            style: const TextStyle(color: Color(0xFF8B949E), fontSize: 13)),
          const SizedBox(height: 12),
          Text(
            'Configured backend: ${AppConfig.apiHost}:${AppConfig.apiPort}',
            textAlign: TextAlign.center,
            style: const TextStyle(color: Color(0xFF484F58), fontSize: 11, fontFamily: 'monospace'),
          ),
          const SizedBox(height: 24),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF1F6FEB),
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
            ),
            onPressed: _reset,
            child: const Text('Try Again'),
          ),
        ],
      ),
    ),
  );
}

class _InfoCard extends StatelessWidget {
  final String title;
  final List<List<String>> rows;
  const _InfoCard({required this.title, required this.rows});

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(14),
    decoration: BoxDecoration(
      color:        const Color(0xFF0D1117),
      borderRadius: BorderRadius.circular(10),
      border:       Border.all(color: const Color(0xFF21262D)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: const TextStyle(
          color: Color(0xFF8B949E), fontSize: 12, fontWeight: FontWeight.w700,
        )),
        const SizedBox(height: 10),
        ...rows.map((row) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 100,
                child: Text(row[0], style: const TextStyle(color: Color(0xFF8B949E), fontSize: 12)),
              ),
              Expanded(
                child: Text(row[1], style: const TextStyle(
                  color: Color(0xFFE6EDF3), fontSize: 12, fontWeight: FontWeight.w600,
                )),
              ),
            ],
          ),
        )),
      ],
    ),
  );
}

// ─── Scan overlay painter ─────────────────────────────────────────────────────

class _ScanOverlayPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()..color = Colors.black.withAlpha(130);
    final scanRect = Rect.fromCenter(
      center: Offset(size.width / 2, size.height / 2 - 40),
      width:  240,
      height: 240,
    );

    canvas.drawRect(Rect.fromLTWH(0, 0, size.width, size.height), paint);
    canvas.drawRect(scanRect, Paint()..blendMode = BlendMode.clear);

    // Corner indicators
    final cornerPaint = Paint()
      ..color       = const Color(0xFF388BFD)
      ..strokeWidth = 3
      ..style       = PaintingStyle.stroke;
    const len = 24.0;

    for (final corner in [
      [scanRect.topLeft,     1.0,  1.0],
      [scanRect.topRight,   -1.0,  1.0],
      [scanRect.bottomLeft,  1.0, -1.0],
      [scanRect.bottomRight,-1.0, -1.0],
    ]) {
      final p  = corner[0] as Offset;
      final dx = corner[1] as double;
      final dy = corner[2] as double;
      canvas.drawLine(p, Offset(p.dx + dx * len, p.dy), cornerPaint);
      canvas.drawLine(p, Offset(p.dx, p.dy + dy * len), cornerPaint);
    }
  }

  @override
  bool shouldRepaint(_) => false;
}
