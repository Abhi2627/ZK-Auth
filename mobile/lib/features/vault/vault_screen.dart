import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'dart:convert';
import 'package:crypto/crypto.dart';
import 'package:qr_flutter/qr_flutter.dart';

// ─── Document model ───────────────────────────────────────────────────────────

class ZkDocument {
  final String id;
  final String type;
  final String title;
  final String issuer;
  final String issuedDate;
  final String expiryDate;
  final String merkleRoot;
  final String holderDid;
  final Map<String, String> leafHashes;
  final String digitalSignature;
  final bool   isVerified;

  const ZkDocument({
    required this.id,
    required this.type,
    required this.title,
    required this.issuer,
    required this.issuedDate,
    required this.expiryDate,
    required this.merkleRoot,
    required this.holderDid,
    required this.leafHashes,
    required this.digitalSignature,
    required this.isVerified,
  });

  // Unique fingerprint — SHA-256(merkleRoot + id + issuedDate)
  // Used to detect copies: two documents with the same fingerprint are duplicates
  String get fingerprint {
    final data = utf8.encode('$merkleRoot:$id:$issuedDate');
    return sha256.convert(data).toString().substring(0, 16).toUpperCase();
  }

  // QR payload — compact JSON, NOT the full VC (keeps QR scannable)
  String get qrPayload => jsonEncode({
    'type':      type,
    'id':        id,
    'issuer':    issuer,
    'root':      merkleRoot.substring(0, 16),
    'fp':        fingerprint,
    'issued':    issuedDate,
    'holder':    holderDid.substring(0, 20),
    'sig':       digitalSignature.substring(0, 16),
    'verify':    'http://192.168.0.167:3001/api/verifier/verify-doc/$id',
  });
}

// ─── Demo MANIT admission letter ─────────────────────────────────────────────

ZkDocument buildManitAdmissionLetter() {
  const merkleRoot = 'a3f8c2d1e94b5607f812a34d9c78b2e561f034a7d89c12b4e657f3a089c41d2';
  const id         = 'MANIT-2024-MTECH-AI-001';
  const issuedDate = '2024-08-01';

  // Leaf hashes: Poseidon(attribute_value || salt)
  // These CANNOT be reversed to get the original value without the salt
  const leafHashes = {
    'student_name':   'f3a8c2d1e94b560', // Poseidon(name || salt)
    'program':        'b7e2a9f4c8d1350', // Poseidon("M.Tech AI" || salt)
    'roll_number':    'c4d8e3f7a2b9610', // Poseidon(roll || salt)
    'admission_year': 'e9b4c7d2f1a8350', // Poseidon(2024 || salt)
    'nationality':    '09e8b7e3271d9ac', // Poseidon(356 || salt) [India]
  };

  // Digital signature = SHA-256(merkleRoot + issuerDID + issuedDate)
  final sigData = utf8.encode('$merkleRoot:did:web:gov.zk-auth.io:$issuedDate');
  final sig     = sha256.convert(sigData).toString();

  return ZkDocument(
    id:               id,
    type:             'AdmissionLetter',
    title:            'MANIT Bhopal — M.Tech AI Admission Letter',
    issuer:           'did:web:gov.zk-auth.io',
    issuedDate:       issuedDate,
    expiryDate:       '2026-07-31',
    merkleRoot:       merkleRoot,
    holderDid:        'did:key:z6MkManitStudent2024AI',
    leafHashes:       leafHashes,
    digitalSignature: sig,
    isVerified:       true,
  );
}

// ─── Vault Screen ─────────────────────────────────────────────────────────────

class VaultScreen extends StatefulWidget {
  const VaultScreen({super.key});

  @override
  State<VaultScreen> createState() => _VaultScreenState();
}

class _VaultScreenState extends State<VaultScreen> {
  final List<ZkDocument> _documents = [buildManitAdmissionLetter()];
  ZkDocument? _selected;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF010409),
      appBar: AppBar(
        title: const Text('Document Vault'),
        actions: [
          IconButton(
            icon: const Icon(Icons.add_circle_outline),
            onPressed: () => _showAddDocumentDialog(),
            tooltip: 'Add document via QR',
          ),
        ],
      ),
      body: _selected != null
          ? _DocumentDetail(
              doc:     _selected!,
              onBack:  () => setState(() => _selected = null),
            )
          : _DocumentList(
              documents: _documents,
              onSelect:  (doc) => setState(() => _selected = doc),
            ),
    );
  }

  void _showAddDocumentDialog() {
    showModalBottomSheet(
      context: context,
      backgroundColor: const Color(0xFF0D1117),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 40, height: 4,
              decoration: BoxDecoration(
                color: const Color(0xFF30363D),
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            const SizedBox(height: 20),
            const Text('Add Document', style: TextStyle(
              color: Color(0xFFE6EDF3), fontWeight: FontWeight.w700, fontSize: 18,
            )),
            const SizedBox(height: 20),
            _AddOption(icon: '📷', title: 'Scan QR Code', subtitle: 'Scan issuer QR to import credential'),
            const SizedBox(height: 12),
            _AddOption(icon: '🎓', title: 'Request from MANIT', subtitle: 'Connect to university portal'),
            const SizedBox(height: 12),
            _AddOption(icon: '🏛', title: 'Government ID', subtitle: 'Import from Aadhaar/DigiLocker'),
          ],
        ),
      ),
    );
  }
}

class _AddOption extends StatelessWidget {
  final String icon, title, subtitle;
  const _AddOption({required this.icon, required this.title, required this.subtitle});

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(14),
    decoration: BoxDecoration(
      color:        const Color(0xFF161B22),
      borderRadius: BorderRadius.circular(10),
      border:       Border.all(color: const Color(0xFF30363D)),
    ),
    child: Row(
      children: [
        Text(icon, style: const TextStyle(fontSize: 24)),
        const SizedBox(width: 12),
        Expanded(child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: const TextStyle(color: Color(0xFFE6EDF3), fontWeight: FontWeight.w600, fontSize: 14)),
            Text(subtitle, style: const TextStyle(color: Color(0xFF8B949E), fontSize: 12)),
          ],
        )),
        const Icon(Icons.arrow_forward_ios, color: Color(0xFF484F58), size: 14),
      ],
    ),
  );
}

// ─── Document list ────────────────────────────────────────────────────────────

class _DocumentList extends StatelessWidget {
  final List<ZkDocument> documents;
  final void Function(ZkDocument) onSelect;
  const _DocumentList({required this.documents, required this.onSelect});

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
        child: Text('${documents.length} document${documents.length == 1 ? '' : 's'}',
          style: const TextStyle(color: Color(0xFF8B949E), fontSize: 12)),
      ),
      Expanded(
        child: ListView.separated(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          itemCount: documents.length,
          separatorBuilder: (_, __) => const SizedBox(height: 10),
          itemBuilder: (_, i) => _DocumentTile(
            doc:      documents[i],
            onTap:    () => onSelect(documents[i]),
          ),
        ),
      ),
    ],
  );
}

class _DocumentTile extends StatelessWidget {
  final ZkDocument doc;
  final VoidCallback onTap;
  const _DocumentTile({required this.doc, required this.onTap});

  @override
  Widget build(BuildContext context) => GestureDetector(
    onTap: onTap,
    child: Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color:        const Color(0xFF0D1117),
        borderRadius: BorderRadius.circular(12),
        border:       Border.all(
          color: doc.isVerified ? const Color(0xFF238636) : const Color(0xFF21262D),
        ),
      ),
      child: Row(
        children: [
          Container(
            width: 48, height: 48,
            decoration: BoxDecoration(
              gradient: const LinearGradient(
                colors: [Color(0xFF1F6FEB), Color(0xFF238636)],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
              borderRadius: BorderRadius.circular(10),
            ),
            child: const Center(child: Text('🎓', style: TextStyle(fontSize: 24))),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(doc.title, style: const TextStyle(
                  color: Color(0xFFE6EDF3), fontWeight: FontWeight.w600, fontSize: 13,
                )),
                const SizedBox(height: 3),
                Text(doc.issuer.replaceFirst('did:web:', ''),
                  style: const TextStyle(color: Color(0xFF8B949E), fontSize: 11)),
                const SizedBox(height: 5),
                Row(children: [
                  if (doc.isVerified) ...[
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(
                        color: const Color(0xFF052E16),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: const Text('✓ Verified', style: TextStyle(
                        color: Color(0xFF4ADE80), fontSize: 10, fontWeight: FontWeight.w700,
                      )),
                    ),
                    const SizedBox(width: 6),
                  ],
                  Text('FP: ${doc.fingerprint}', style: const TextStyle(
                    color: Color(0xFF484F58), fontSize: 9, fontFamily: 'monospace',
                  )),
                ]),
              ],
            ),
          ),
          const Icon(Icons.chevron_right, color: Color(0xFF484F58)),
        ],
      ),
    ),
  );
}

// ─── Document detail ──────────────────────────────────────────────────────────

class _DocumentDetail extends StatefulWidget {
  final ZkDocument doc;
  final VoidCallback onBack;
  const _DocumentDetail({required this.doc, required this.onBack});

  @override
  State<_DocumentDetail> createState() => _DocumentDetailState();
}

class _DocumentDetailState extends State<_DocumentDetail>
    with SingleTickerProviderStateMixin {
  late TabController _tabs;

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 3, vsync: this);
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final doc = widget.doc;
    return Column(
      children: [
        // Header
        Container(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 0),
          color: const Color(0xFF0D1117),
          child: Column(
            children: [
              Row(
                children: [
                  IconButton(
                    icon: const Icon(Icons.arrow_back, color: Color(0xFFE6EDF3)),
                    onPressed: widget.onBack,
                  ),
                  Expanded(
                    child: Text(doc.title,
                      style: const TextStyle(color: Color(0xFFE6EDF3), fontWeight: FontWeight.w700, fontSize: 14),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.share_outlined, color: Color(0xFF388BFD)),
                    onPressed: () {},
                  ),
                ],
              ),
              TabBar(
                controller: _tabs,
                labelColor:        const Color(0xFF388BFD),
                unselectedLabelColor: const Color(0xFF8B949E),
                indicatorColor:    const Color(0xFF388BFD),
                tabs: const [
                  Tab(text: 'Document'),
                  Tab(text: 'ZK Proof'),
                  Tab(text: 'QR Code'),
                ],
              ),
            ],
          ),
        ),

        Expanded(
          child: TabBarView(
            controller: _tabs,
            children: [
              _DocumentTab(doc: doc),
              _ZkProofTab(doc: doc),
              _QrTab(doc: doc),
            ],
          ),
        ),
      ],
    );
  }
}

// ─── Tab: Document preview ────────────────────────────────────────────────────

class _DocumentTab extends StatelessWidget {
  final ZkDocument doc;
  const _DocumentTab({required this.doc});

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
    padding: const EdgeInsets.all(16),
    child: Column(
      children: [
        // Admission letter card
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            gradient: const LinearGradient(
              colors: [Color(0xFF0D2149), Color(0xFF0A1D0F)],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: const Color(0xFF1F6FEB), width: 1.5),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Institute header
              Row(
                children: [
                  Container(
                    width: 48, height: 48,
                    decoration: BoxDecoration(
                      gradient: const LinearGradient(
                        colors: [Color(0xFF1F6FEB), Color(0xFF238636)],
                      ),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: const Center(child: Text('🏛', style: TextStyle(fontSize: 24))),
                  ),
                  const SizedBox(width: 12),
                  const Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('MANIT Bhopal', style: TextStyle(
                          color: Color(0xFFE6EDF3), fontWeight: FontWeight.w800, fontSize: 15,
                        )),
                        Text('Maulana Azad National Institute of Technology', style: TextStyle(
                          color: Color(0xFF8B949E), fontSize: 9,
                        )),
                        Text('(Institute of National Importance, Govt. of India)', style: TextStyle(
                          color: Color(0xFF484F58), fontSize: 9,
                        )),
                      ],
                    ),
                  ),
                ],
              ),

              const SizedBox(height: 16),
              const Divider(color: Color(0xFF1F6FEB), height: 1),
              const SizedBox(height: 16),

              const Center(
                child: Text('PROVISIONAL ADMISSION LETTER', style: TextStyle(
                  color: Color(0xFF4ADE80), fontWeight: FontWeight.w800, fontSize: 13,
                  letterSpacing: 1.2,
                )),
              ),
              const SizedBox(height: 16),

              _DetailRow('Programme', 'Master of Technology (M.Tech) — Artificial Intelligence'),
              _DetailRow('Academic Year', '2024 – 2026 (Batch: 2024-26)'),
              _DetailRow('Admission Category', 'GATE Qualified / Merit Based'),
              _DetailRow('Department', 'Computer Science & Engineering'),
              _DetailRow('Duration', '2 Years (4 Semesters)'),
              _DetailRow('Issued Date', doc.issuedDate),
              _DetailRow('Valid Until', doc.expiryDate),
              _DetailRow('Document ID', doc.id),

              const SizedBox(height: 16),

              // Anti-forgery section
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: const Color(0xFF0A1D0F),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: const Color(0xFF238636)),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('🔐 Anti-Forgery Fingerprint', style: TextStyle(
                      color: Color(0xFF4ADE80), fontWeight: FontWeight.w700, fontSize: 12,
                    )),
                    const SizedBox(height: 8),
                    SelectableText(
                      'FP: ${doc.fingerprint}',
                      style: const TextStyle(
                        color: Color(0xFF4ADE80), fontFamily: 'monospace', fontSize: 11,
                        letterSpacing: 1.5,
                      ),
                    ),
                    const SizedBox(height: 4),
                    const Text(
                      'Any copied document will have the same fingerprint.\n'
                      'Verify authenticity by scanning the QR code.',
                      style: TextStyle(color: Color(0xFF3FB950), fontSize: 10, height: 1.4),
                    ),
                  ],
                ),
              ),

              const SizedBox(height: 12),

              // Digital signature
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: const Color(0xFF0D1117),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: const Color(0xFF21262D)),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('✍️  Digital Signature', style: TextStyle(
                      color: Color(0xFF8B949E), fontWeight: FontWeight.w700, fontSize: 11,
                    )),
                    const SizedBox(height: 6),
                    SelectableText(
                      doc.digitalSignature.substring(0, 32) + '…',
                      style: const TextStyle(
                        color: Color(0xFF388BFD), fontFamily: 'monospace', fontSize: 9,
                      ),
                    ),
                    const SizedBox(height: 4),
                    const Text('SHA-256(merkleRoot || issuerDID || issuedDate)',
                      style: TextStyle(color: Color(0xFF484F58), fontSize: 9)),
                  ],
                ),
              ),
            ],
          ),
        ),
      ],
    ),
  );
}

class _DetailRow extends StatelessWidget {
  final String label, value;
  const _DetailRow(this.label, this.value);
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 5),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 120,
          child: Text(label, style: const TextStyle(color: Color(0xFF8B949E), fontSize: 11)),
        ),
        Expanded(
          child: Text(value, style: const TextStyle(color: Color(0xFFE6EDF3), fontSize: 11, fontWeight: FontWeight.w600)),
        ),
      ],
    ),
  );
}

// ─── Tab: ZK Proof ───────────────────────────────────────────────────────────

class _ZkProofTab extends StatelessWidget {
  final ZkDocument doc;
  const _ZkProofTab({required this.doc});

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
    padding: const EdgeInsets.all(16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('Zero-Knowledge Commitments', style: TextStyle(
          color: Color(0xFFE6EDF3), fontWeight: FontWeight.w700, fontSize: 15,
        )),
        const SizedBox(height: 4),
        const Text(
          'These are cryptographic hashes of your attributes.\n'
          'Raw values are stored ONLY on your device — never on any server.',
          style: TextStyle(color: Color(0xFF8B949E), fontSize: 12, height: 1.5),
        ),
        const SizedBox(height: 16),

        // Two-column: Raw (hidden) vs Commitment
        Row(
          children: [
            Expanded(child: _Column(
              title: '🔒 Raw Data',
              titleColor: const Color(0xFFF87171),
              note: 'On device only',
              items: const [
                ['Student Name', '••••••••'],
                ['Programme', '••••••••'],
                ['Roll Number', '••••••••'],
                ['Admit Year', '••••••••'],
                ['Nationality', '••••••••'],
              ],
            )),
            const SizedBox(width: 8),
            Expanded(child: _Column(
              title: '✅ Commitments',
              titleColor: const Color(0xFF4ADE80),
              note: 'Stored on server',
              items: doc.leafHashes.entries.map((e) =>
                [e.key.replaceAll('_', ' '), '0x${e.value}…']).toList(),
            )),
          ],
        ),

        const SizedBox(height: 16),

        // Merkle root
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: const Color(0xFF0D2149),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: const Color(0xFF1F6FEB)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Merkle Root (public, on-chain commitment)', style: TextStyle(
                color: Color(0xFF79C0FF), fontWeight: FontWeight.w700, fontSize: 11,
              )),
              const SizedBox(height: 6),
              SelectableText(
                doc.merkleRoot,
                style: const TextStyle(
                  color: Color(0xFF388BFD), fontFamily: 'monospace', fontSize: 9,
                ),
              ),
            ],
          ),
        ),

        const SizedBox(height: 12),

        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: const Color(0xFF0A1D0F),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: const Color(0xFF238636)),
          ),
          child: const Text(
            '📋  How to prove without revealing:\n\n'
            'Example — To prove "I am an M.Tech AI student" to an employer:\n'
            '1. Select the "programme" attribute\n'
            '2. App generates a Groth16 ZK proof from your local secret\n'
            '3. Employer receives: proof + merkle root\n'
            '4. Employer verifies: proof is valid ✓\n'
            '5. Employer learns: you are enrolled — NOTHING else',
            style: TextStyle(color: Color(0xFF3FB950), fontSize: 11, height: 1.6),
          ),
        ),
      ],
    ),
  );
}

class _Column extends StatelessWidget {
  final String title, note;
  final Color  titleColor;
  final List<List<String>> items;
  const _Column({required this.title, required this.titleColor, required this.note, required this.items});

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(10),
    decoration: BoxDecoration(
      color:        const Color(0xFF0D1117),
      borderRadius: BorderRadius.circular(8),
      border:       Border.all(color: const Color(0xFF21262D)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: TextStyle(color: titleColor, fontWeight: FontWeight.w700, fontSize: 10)),
        Text(note, style: const TextStyle(color: Color(0xFF484F58), fontSize: 9)),
        const SizedBox(height: 8),
        ...items.map((item) => Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(item[0], style: const TextStyle(color: Color(0xFF8B949E), fontSize: 9)),
              Text(item[1], style: const TextStyle(color: Color(0xFFE6EDF3), fontFamily: 'monospace', fontSize: 9),
                overflow: TextOverflow.ellipsis),
            ],
          ),
        )),
      ],
    ),
  );
}

// ─── Tab: QR Code ─────────────────────────────────────────────────────────────

class _QrTab extends StatelessWidget {
  final ZkDocument doc;
  const _QrTab({required this.doc});

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
    padding: const EdgeInsets.all(16),
    child: Column(
      children: [
        const Text('Verification QR Code', style: TextStyle(
          color: Color(0xFFE6EDF3), fontWeight: FontWeight.w700, fontSize: 15,
        )),
        const SizedBox(height: 8),
        const Text(
          'Show this to any ZK-Auth compatible verifier.\n'
          'Contains credential ID, merkle root fragment, and fingerprint.\n'
          'Scannable by Google Lens.',
          textAlign: TextAlign.center,
          style: TextStyle(color: Color(0xFF8B949E), fontSize: 12, height: 1.5),
        ),
        const SizedBox(height: 20),

        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color:        Colors.white,
            borderRadius: BorderRadius.circular(16),
          ),
          child: QrImageView(
            data:                doc.qrPayload,
            version:             QrVersions.auto,
            size:                220,
            errorCorrectionLevel: QrErrorCorrectLevel.M,
            backgroundColor:     Colors.white,
          ),
        ),

        const SizedBox(height: 16),

        // Fingerprint display
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color:        const Color(0xFF0D1117),
            borderRadius: BorderRadius.circular(10),
            border:       Border.all(color: const Color(0xFF238636)),
          ),
          child: Column(
            children: [
              const Text('Document Fingerprint', style: TextStyle(
                color: Color(0xFF8B949E), fontSize: 11, fontWeight: FontWeight.w600,
              )),
              const SizedBox(height: 8),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    doc.fingerprint,
                    style: const TextStyle(
                      color:         Color(0xFF4ADE80),
                      fontFamily:    'monospace',
                      fontSize:      18,
                      fontWeight:    FontWeight.w700,
                      letterSpacing: 2,
                    ),
                  ),
                  const SizedBox(width: 8),
                  GestureDetector(
                    onTap: () {
                      Clipboard.setData(ClipboardData(text: doc.fingerprint));
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('Fingerprint copied')),
                      );
                    },
                    child: const Icon(Icons.copy, color: Color(0xFF388BFD), size: 16),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              const Text(
                'A copied document has the SAME fingerprint.\n'
                'The issuer database shows which one was issued first.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Color(0xFF484F58), fontSize: 10, height: 1.4),
              ),
            ],
          ),
        ),

        const SizedBox(height: 12),

        // What's in the QR
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color:        const Color(0xFF0D1117),
            borderRadius: BorderRadius.circular(8),
            border:       Border.all(color: const Color(0xFF21262D)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('QR contains (NOT sensitive):', style: TextStyle(
                color: Color(0xFF8B949E), fontSize: 11, fontWeight: FontWeight.w600,
              )),
              const SizedBox(height: 8),
              ...const [
                '✅  Document type and ID',
                '✅  Partial merkle root (first 16 chars)',
                '✅  Document fingerprint',
                '✅  Issuer DID (not the full key)',
                '✅  Verification URL',
                '❌  No student name, DOB, or any PII',
              ].map((item) => Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Text(item, style: const TextStyle(color: Color(0xFFC9D1D9), fontSize: 11)),
              )),
            ],
          ),
        ),
      ],
    ),
  );
}
