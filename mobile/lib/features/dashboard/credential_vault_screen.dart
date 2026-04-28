/// CredentialVaultScreen — Flutter wallet document vault
///
/// Displays issued W3C VCs with the same raw/commitment distinction as the
/// web DocumentVault. Uses AnimatedList for credential addition/removal and
/// an ExpansionTile for the two-column comparison view.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

// ─── Model ────────────────────────────────────────────────────────────────────

class StoredVC {
  final String              id;
  final String              credentialType;
  final String              issuerDid;
  final String?             issuerName;
  final String              merkleRoot;
  final List<String>        attributeNames;
  final Map<String, String> leafHashes;   // public commitments
  final Map<String, String> salts;        // stored locally, never sent out
  final DateTime            issuedAt;
  final DateTime?           validUntil;

  bool get isExpired => validUntil != null && validUntil!.isBefore(DateTime.now());

  const StoredVC({
    required this.id,
    required this.credentialType,
    required this.issuerDid,
    this.issuerName,
    required this.merkleRoot,
    required this.attributeNames,
    required this.leafHashes,
    required this.salts,
    required this.issuedAt,
    this.validUntil,
  });
}

// ─── Screen ───────────────────────────────────────────────────────────────────

class CredentialVaultScreen extends StatelessWidget {
  final List<StoredVC>                credentials;
  final void Function(StoredVC)?      onGenerateProof;

  const CredentialVaultScreen({
    super.key,
    required this.credentials,
    this.onGenerateProof,
  });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0D1117),
      appBar: AppBar(
        backgroundColor:  const Color(0xFF161B22),
        foregroundColor:  const Color(0xFFE6EDF3),
        title:            const Text('Credential Vault'),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(36),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
            child: Text(
              'Your wallet holds cryptographic commitments — never raw personal data.',
              style: TextStyle(color: Colors.grey.shade600, fontSize: 11),
            ),
          ),
        ),
      ),
      body: credentials.isEmpty
          ? const _EmptyState()
          : ListView.separated(
              padding:    const EdgeInsets.all(16),
              itemCount:  credentials.length,
              separatorBuilder: (_, __) => const SizedBox(height: 10),
              itemBuilder: (context, i) => _CredentialCard(
                credential:     credentials[i],
                onGenerateProof: onGenerateProof,
              ),
            ),
    );
  }
}

// ─── Credential card ──────────────────────────────────────────────────────────

class _CredentialCard extends StatelessWidget {
  final StoredVC                  credential;
  final void Function(StoredVC)?  onGenerateProof;

  const _CredentialCard({required this.credential, this.onGenerateProof});

  @override
  Widget build(BuildContext context) {
    return AnimatedOpacity(
      opacity:  credential.isExpired ? 0.55 : 1.0,
      duration: const Duration(milliseconds: 300),
      child: Container(
        decoration: BoxDecoration(
          color:        const Color(0xFF161B22),
          border:       Border.all(color: const Color(0xFF30363D)),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Theme(
          data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
          child: ExpansionTile(
            tilePadding:       const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
            childrenPadding:   const EdgeInsets.fromLTRB(14, 0, 14, 14),
            leading:           Text(_credIcon(credential.credentialType),
                                    style: const TextStyle(fontSize: 26)),
            title:             Text(
              credential.credentialType,
              style: const TextStyle(color: Color(0xFFE6EDF3), fontWeight: FontWeight.w600, fontSize: 14),
            ),
            subtitle: Text(
              '${credential.issuerName ?? credential.issuerDid} · '
              '${_formatDate(credential.issuedAt)}'
              '${credential.isExpired ? ' · EXPIRED' : ''}',
              style: TextStyle(
                color: credential.isExpired ? const Color(0xFFF85149) : const Color(0xFF8B949E),
                fontSize: 11,
              ),
            ),
            iconColor:         const Color(0xFF8B949E),
            collapsedIconColor: const Color(0xFF8B949E),
            children: [
              // Two-column comparison
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(child: _RawColumn(attributeNames: credential.attributeNames)),
                  const SizedBox(width: 8),
                  Expanded(child: _CommitColumn(
                    attributeNames: credential.attributeNames,
                    leafHashes:     credential.leafHashes,
                  )),
                ],
              ),
              const SizedBox(height: 10),

              // Merkle root
              _InfoRow(label: 'Merkle Root', value: _truncate(credential.merkleRoot)),

              const SizedBox(height: 6),
              _InfoRow(label: 'Issuer DID', value: credential.issuerDid, isCode: true, color: const Color(0xFF388BFD)),

              if (!credential.isExpired && onGenerateProof != null) ...[
                const SizedBox(height: 12),
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF1F6FEB),
                      foregroundColor: Colors.white,
                      padding:         const EdgeInsets.symmetric(vertical: 12),
                      shape:           RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                    ),
                    onPressed: () => onGenerateProof!(credential),
                    child: const Text('Generate Selective Disclosure Proof'),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  String _credIcon(String type) {
    final t = type.toLowerCase();
    if (t.contains('government') || t.contains('id')) return '🪪';
    if (t.contains('university') || t.contains('degree')) return '🎓';
    return '📄';
  }

  String _formatDate(DateTime d) =>
      '${d.day.toString().padLeft(2, '0')}/${d.month.toString().padLeft(2, '0')}/${d.year}';

  String _truncate(String hex, [int chars = 12]) {
    if (hex.isEmpty) return '—';
    final clean = hex.replaceAll('0x', '');
    return '0x${clean.substring(0, chars.clamp(0, clean.length))}…';
  }
}

// ─── Sub-widgets ──────────────────────────────────────────────────────────────

class _RawColumn extends StatelessWidget {
  final List<String> attributeNames;
  const _RawColumn({required this.attributeNames});

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(10),
    decoration: BoxDecoration(
      color:        const Color(0xFF0D1117),
      borderRadius: BorderRadius.circular(6),
      border:       Border.all(color: const Color(0xFF21262D)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(children: [
          const Text('🔒', style: TextStyle(fontSize: 12)),
          const SizedBox(width: 4),
          Text('Raw Attributes', style: TextStyle(fontSize: 10, color: Colors.grey.shade600,
              fontWeight: FontWeight.w700, letterSpacing: 0.6)),
        ]),
        const SizedBox(height: 4),
        Text('Stored locally only', style: TextStyle(fontSize: 10, color: Colors.grey.shade700)),
        const SizedBox(height: 8),
        ...attributeNames.map((name) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 3),
          child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
            Text(_fmt(name), style: const TextStyle(fontSize: 11, color: Color(0xFFC9D1D9),
                fontFamily: 'monospace')),
            const Text('••••••', style: TextStyle(fontSize: 11, color: Color(0xFF484F58),
                letterSpacing: 2)),
          ]),
        )),
      ],
    ),
  );

  String _fmt(String n) => n.replaceAll('_', ' ');
}

class _CommitColumn extends StatelessWidget {
  final List<String>        attributeNames;
  final Map<String, String> leafHashes;
  const _CommitColumn({required this.attributeNames, required this.leafHashes});

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(10),
    decoration: BoxDecoration(
      color:        const Color(0xFF0A1D0F),
      borderRadius: BorderRadius.circular(6),
      border:       Border.all(color: const Color(0xFF1A4028)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(children: [
          const Text('✅', style: TextStyle(fontSize: 12)),
          const SizedBox(width: 4),
          const Text('Commitments', style: TextStyle(fontSize: 10, color: Color(0xFF4ADE80),
              fontWeight: FontWeight.w700, letterSpacing: 0.6)),
        ]),
        const SizedBox(height: 4),
        const Text('On server (not reversible)', style: TextStyle(fontSize: 10, color: Color(0xFF3FB950))),
        const SizedBox(height: 8),
        ...attributeNames.map((name) {
          final hash = leafHashes[name] ?? '';
          final truncated = hash.isNotEmpty
              ? '${hash.substring(0, hash.length.clamp(0, 8))}…'
              : '—';
          return Padding(
            padding: const EdgeInsets.symmetric(vertical: 3),
            child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
              Text(name.replaceAll('_', ' '),
                  style: const TextStyle(fontSize: 11, color: Color(0xFFC9D1D9), fontFamily: 'monospace')),
              GestureDetector(
                onTap: () {
                  Clipboard.setData(ClipboardData(text: hash));
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Hash copied'), duration: Duration(seconds: 1)));
                },
                child: Text(truncated, style: const TextStyle(fontSize: 10, color: Color(0xFF3FB950),
                    fontFamily: 'monospace')),
              ),
            ]),
          );
        }),
      ],
    ),
  );
}

class _InfoRow extends StatelessWidget {
  final String  label;
  final String  value;
  final bool    isCode;
  final Color?  color;
  const _InfoRow({required this.label, required this.value, this.isCode = false, this.color});

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
    decoration: BoxDecoration(color: const Color(0xFF161B22), borderRadius: BorderRadius.circular(6)),
    child: Row(children: [
      Text('$label: ', style: const TextStyle(fontSize: 10, color: Color(0xFF8B949E))),
      Expanded(child: Text(
        value,
        style: TextStyle(
          fontSize:   10,
          color:      color ?? const Color(0xFF4ADE80),
          fontFamily: isCode ? 'monospace' : null,
          overflow:   TextOverflow.ellipsis,
        ),
      )),
    ]),
  );
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) => const Center(
    child: Column(mainAxisSize: MainAxisSize.min, children: [
      Text('🔐', style: TextStyle(fontSize: 48)),
      SizedBox(height: 16),
      Text('No credentials in vault', style: TextStyle(color: Color(0xFFE6EDF3), fontSize: 16, fontWeight: FontWeight.w600)),
      SizedBox(height: 8),
      Text('Request a credential from an Issuer to get started.', style: TextStyle(color: Color(0xFF8B949E), fontSize: 13)),
    ]),
  );
}
