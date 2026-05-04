/// InboxScreen — Pending verification requests from third parties.
///
/// Flow:
///   1. Bank/employer sends POST /api/v1/verify-request/send to backend
///   2. Backend stores the request + pushes a WebSocket notification
///   3. User opens this screen → sees the pending request
///   4. User reviews each claimed attribute → toggles approved/rejected
///   5. User taps Approve → POST /api/v1/verify-request/:id/approve
///   6. Bank's dashboard receives the notification via Redis pub/sub
///
/// This replaces QR-only verification for remote/asynchronous use cases.

import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:dio/dio.dart';
import '../../core/api/http_client.dart';
import '../../core/storage/secure_storage.dart';

// ─── Models ───────────────────────────────────────────────────────────────────

class RequestedClaim {
  final String attributeName;
  final String predicate;
  final num    threshold;
  final String displayLabel;
  final String privacyStatement;
  bool approved;

  RequestedClaim({
    required this.attributeName,
    required this.predicate,
    required this.threshold,
    required this.displayLabel,
    required this.privacyStatement,
    this.approved = true,
  });

  factory RequestedClaim.fromJson(Map<String, dynamic> j) => RequestedClaim(
    attributeName:    j['attribute_name'] as String,
    predicate:        j['predicate'] as String,
    threshold:        j['threshold'] as num,
    displayLabel:     j['display_label'] as String,
    privacyStatement: j['privacy_statement'] as String,
  );
}

class VerificationRequestModel {
  final String              id;
  final String              verifierDid;
  final String              verifierName;
  final String              purpose;
  final List<RequestedClaim> claims;
  final String              expiresAt;

  const VerificationRequestModel({
    required this.id,
    required this.verifierDid,
    required this.verifierName,
    required this.purpose,
    required this.claims,
    required this.expiresAt,
  });

  factory VerificationRequestModel.fromJson(Map<String, dynamic> j) =>
    VerificationRequestModel(
      id:           j['id'] as String,
      verifierDid:  j['verifier_did'] as String,
      verifierName: j['verifier_name'] as String,
      purpose:      j['purpose'] as String,
      expiresAt:    j['expires_at'] as String,
      claims: (j['requested_claims'] as List<dynamic>)
          .map((c) => RequestedClaim.fromJson(c as Map<String, dynamic>))
          .toList(),
    );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

class InboxScreen extends StatefulWidget {
  final ZkAuthHttpClient client;
  const InboxScreen({super.key, required this.client});

  @override
  State<InboxScreen> createState() => _InboxScreenState();
}

class _InboxScreenState extends State<InboxScreen> {
  List<VerificationRequestModel> _requests = [];
  bool    _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final r = await widget.client.dio.get<Map<String, dynamic>>('/verify-request/pending');
      final list = (r.data!['requests'] as List<dynamic>)
          .map((e) => VerificationRequestModel.fromJson(e as Map<String, dynamic>))
          .toList();
      setState(() { _requests = list; });
    } on DioException catch (e) {
      setState(() { _error = e.message; });
    } finally {
      setState(() { _loading = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF010409),
      appBar: AppBar(
        title: Row(
          children: [
            const Text('Verification Requests'),
            if (_requests.isNotEmpty) ...[
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: const Color(0xFF1F6FEB),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Text('${_requests.length}',
                  style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w700)),
              ),
            ],
          ],
        ),
        actions: [
          IconButton(icon: const Icon(Icons.refresh), onPressed: _load),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: Color(0xFF388BFD)))
          : _error != null
            ? _ErrorView(error: _error!, onRetry: _load)
            : _requests.isEmpty
              ? _EmptyView()
              : ListView.separated(
                  padding: const EdgeInsets.all(16),
                  itemCount: _requests.length,
                  separatorBuilder: (_, __) => const SizedBox(height: 12),
                  itemBuilder: (_, i) => _RequestCard(
                    request: _requests[i],
                    client:  widget.client,
                    onDone:  _load,
                  ),
                ),
    );
  }
}

// ─── Request Card ─────────────────────────────────────────────────────────────

class _RequestCard extends StatefulWidget {
  final VerificationRequestModel request;
  final ZkAuthHttpClient          client;
  final VoidCallback              onDone;
  const _RequestCard({required this.request, required this.client, required this.onDone});

  @override
  State<_RequestCard> createState() => _RequestCardState();
}

class _RequestCardState extends State<_RequestCard> {
  bool _expanded  = true;
  bool _submitting = false;

  @override
  Widget build(BuildContext context) {
    final r = widget.request;
    final expiresIn = DateTime.parse(r.expiresAt).difference(DateTime.now());
    final expired   = expiresIn.isNegative;

    return Container(
      decoration: BoxDecoration(
        color:        const Color(0xFF0D1117),
        borderRadius: BorderRadius.circular(12),
        border:       Border.all(
          color: expired ? const Color(0xFF6E1F1F) : const Color(0xFF1F6FEB),
          width: 1.5,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header
          Padding(
            padding: const EdgeInsets.all(14),
            child: Row(
              children: [
                Container(
                  width: 40, height: 40,
                  decoration: BoxDecoration(
                    color: const Color(0xFF0D2149),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: const Center(child: Text('🏦', style: TextStyle(fontSize: 22))),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(r.verifierName, style: const TextStyle(
                        color: Color(0xFFE6EDF3), fontWeight: FontWeight.w700, fontSize: 15,
                      )),
                      Text(r.verifierDid.replaceFirst('did:web:', ''),
                        style: const TextStyle(color: Color(0xFF8B949E), fontSize: 11)),
                    ],
                  ),
                ),
                if (expired)
                  const _Badge('EXPIRED', Color(0xFFF87171), Color(0xFF450A0A))
                else
                  _Badge(
                    '${expiresIn.inHours}h left',
                    const Color(0xFF388BFD),
                    const Color(0xFF0D2149),
                  ),
              ],
            ),
          ),

          // Purpose
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 0, 14, 12),
            child: Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: const Color(0xFF161B22),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Purpose', style: TextStyle(
                    color: Color(0xFF8B949E), fontSize: 10, fontWeight: FontWeight.w700,
                    letterSpacing: 0.6,
                  )),
                  const SizedBox(height: 4),
                  Text(r.purpose, style: const TextStyle(color: Color(0xFFE6EDF3), fontSize: 13)),
                ],
              ),
            ),
          ),

          // Claims
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 0, 14, 0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Text('Requested Claims', style: TextStyle(
                      color: Color(0xFF8B949E), fontSize: 11, fontWeight: FontWeight.w700,
                    )),
                    const Spacer(),
                    Text('${r.claims.where((c) => c.approved).length}/${r.claims.length} approved',
                      style: const TextStyle(color: Color(0xFF4ADE80), fontSize: 11)),
                  ],
                ),
                const SizedBox(height: 8),
                ...r.claims.map((claim) => _ClaimToggle(
                  claim:    claim,
                  disabled: expired,
                  onToggle: (v) => setState(() => claim.approved = v),
                )),
              ],
            ),
          ),

          const SizedBox(height: 14),

          // Actions
          if (!expired)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
              child: Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      style: OutlinedButton.styleFrom(
                        foregroundColor: const Color(0xFFF87171),
                        side: const BorderSide(color: Color(0xFF6E1F1F)),
                      ),
                      onPressed: _submitting ? null : () => _reject(r.id),
                      child: const Text('Reject All'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    flex: 2,
                    child: ElevatedButton(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF238636),
                        foregroundColor: Colors.white,
                      ),
                      onPressed: _submitting ? null : () => _approve(r),
                      child: _submitting
                          ? const SizedBox(width: 16, height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                          : const Text('Approve Selected'),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Future<void> _approve(VerificationRequestModel r) async {
    final approved = r.claims.where((c) => c.approved).map((c) => c.attributeName).toList();
    if (approved.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please approve at least one claim')),
      );
      return;
    }
    setState(() => _submitting = true);
    try {
      await widget.client.dio.post('/verify-request/${r.id}/approve',
        data: {'approved_claim_names': approved});
      if (mounted) {
        _showResult(context, true, approved, r.claims.where((c) => !c.approved).map((c) => c.attributeName).toList());
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error: $e')));
      }
    } finally {
      setState(() => _submitting = false);
    }
  }

  Future<void> _reject(String id) async {
    setState(() => _submitting = true);
    try {
      await widget.client.dio.post('/verify-request/$id/reject',
        data: {'reason': 'User declined all claims'});
      if (mounted) widget.onDone();
    } finally {
      setState(() => _submitting = false);
    }
  }

  void _showResult(BuildContext ctx, bool approved, List<String> approvedClaims, List<String> rejectedClaims) {
    showDialog(
      context: ctx,
      builder: (_) => AlertDialog(
        backgroundColor: const Color(0xFF0D1117),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: Row(children: const [
          Text('✅', style: TextStyle(fontSize: 24)),
          SizedBox(width: 10),
          Text('Response Sent', style: TextStyle(color: Color(0xFF4ADE80), fontWeight: FontWeight.w700)),
        ]),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (approvedClaims.isNotEmpty) ...[
              const Text('Approved:', style: TextStyle(color: Color(0xFF8B949E), fontSize: 12)),
              ...approvedClaims.map((c) => Text('  ✓ $c',
                style: const TextStyle(color: Color(0xFF4ADE80), fontSize: 13))),
              const SizedBox(height: 8),
            ],
            if (rejectedClaims.isNotEmpty) ...[
              const Text('Rejected (not shared):', style: TextStyle(color: Color(0xFF8B949E), fontSize: 12)),
              ...rejectedClaims.map((c) => Text('  ✗ $c',
                style: const TextStyle(color: Color(0xFFF87171), fontSize: 13))),
              const SizedBox(height: 8),
            ],
            const Text(
              'The verifier received ONLY the approved claims.\nNo raw values were shared.',
              style: TextStyle(color: Color(0xFF8B949E), fontSize: 11, height: 1.5),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () { Navigator.pop(ctx); widget.onDone(); },
            child: const Text('Done', style: TextStyle(color: Color(0xFF388BFD))),
          ),
        ],
      ),
    );
  }
}

// ─── Claim Toggle ─────────────────────────────────────────────────────────────

class _ClaimToggle extends StatelessWidget {
  final RequestedClaim claim;
  final bool           disabled;
  final void Function(bool) onToggle;
  const _ClaimToggle({required this.claim, required this.disabled, required this.onToggle});

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.only(bottom: 8),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color:        claim.approved ? const Color(0xFF0A1D0F) : const Color(0xFF1A0505),
      borderRadius: BorderRadius.circular(8),
      border: Border.all(
        color: claim.approved ? const Color(0xFF238636) : const Color(0xFF6E1F1F),
      ),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Switch(
          value:            claim.approved,
          onChanged:        disabled ? null : onToggle,
          activeColor:      const Color(0xFF4ADE80),
          inactiveThumbColor: const Color(0xFFF87171),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(claim.displayLabel, style: TextStyle(
                color:      claim.approved ? const Color(0xFF4ADE80) : const Color(0xFFF87171),
                fontWeight: FontWeight.w600, fontSize: 13,
              )),
              const SizedBox(height: 3),
              Row(
                children: [
                  const Text('🔒 ', style: TextStyle(fontSize: 11)),
                  Expanded(
                    child: Text(claim.privacyStatement, style: const TextStyle(
                      color: Color(0xFF8B949E), fontSize: 11,
                    )),
                  ),
                ],
              ),
              const SizedBox(height: 2),
              Text(
                '${claim.attributeName} ${_predicateSymbol(claim.predicate)} ${claim.threshold}',
                style: const TextStyle(
                  color: Color(0xFF484F58), fontSize: 10, fontFamily: 'monospace',
                ),
              ),
            ],
          ),
        ),
      ],
    ),
  );

  String _predicateSymbol(String p) => p == 'GTE' ? '≥' : p == 'LTE' ? '≤' : '=';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

class _Badge extends StatelessWidget {
  final String text;
  final Color  fg, bg;
  const _Badge(this.text, this.fg, this.bg);
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
    decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(6)),
    child: Text(text, style: TextStyle(color: fg, fontSize: 10, fontWeight: FontWeight.w700)),
  );
}

class _ErrorView extends StatelessWidget {
  final String       error;
  final VoidCallback onRetry;
  const _ErrorView({required this.error, required this.onRetry});
  @override
  Widget build(BuildContext context) => Center(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Text('⚠️', style: TextStyle(fontSize: 36)),
        const SizedBox(height: 12),
        Text(error, textAlign: TextAlign.center, style: const TextStyle(color: Color(0xFF8B949E))),
        const SizedBox(height: 16),
        ElevatedButton(onPressed: onRetry, child: const Text('Retry')),
      ],
    ),
  );
}

class _EmptyView extends StatelessWidget {
  @override
  Widget build(BuildContext context) => const Center(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text('📭', style: TextStyle(fontSize: 52)),
        SizedBox(height: 16),
        Text('No pending requests', style: TextStyle(
          color: Color(0xFFE6EDF3), fontWeight: FontWeight.w700, fontSize: 16,
        )),
        SizedBox(height: 6),
        Text('When a bank or employer requests verification,\nit will appear here.',
          textAlign: TextAlign.center,
          style: TextStyle(color: Color(0xFF8B949E), fontSize: 13, height: 1.5)),
      ],
    ),
  );
}
