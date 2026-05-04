import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import '../auth/bloc/auth_bloc.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF010409),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // ── Header ─────────────────────────────────────────────────────
              Row(
                children: [
                  Container(
                    width: 40, height: 40,
                    decoration: BoxDecoration(
                      gradient: const LinearGradient(
                        colors: [Color(0xFF1F6FEB), Color(0xFF388BFD)],
                      ),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: const Center(
                      child: Text('ZK', style: TextStyle(
                        color: Colors.white, fontWeight: FontWeight.w900, fontSize: 14,
                      )),
                    ),
                  ),
                  const SizedBox(width: 12),
                  const Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('ZK-Auth DigiLocker', style: TextStyle(
                        color: Color(0xFFE6EDF3), fontWeight: FontWeight.w700, fontSize: 16,
                      )),
                      Text('MANIT Bhopal · Secure Document Vault', style: TextStyle(
                        color: Color(0xFF8B949E), fontSize: 11,
                      )),
                    ],
                  ),
                ],
              ),

              const SizedBox(height: 24),

              // ── Authentication status ───────────────────────────────────────
              BlocBuilder<AuthBloc, AuthState>(
                builder: (context, state) {
                  final sessionId = state is AuthAuthenticated ? state.sessionId : null;
                  return Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      gradient: const LinearGradient(
                        colors: [Color(0xFF0A1D0F), Color(0xFF0D2149)],
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                      ),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: const Color(0xFF238636)),
                    ),
                    child: Row(
                      children: [
                        const Text('✅', style: TextStyle(fontSize: 28)),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Text('ZKP Authenticated', style: TextStyle(
                                color: Color(0xFF4ADE80), fontWeight: FontWeight.w700, fontSize: 15,
                              )),
                              Text(
                                sessionId != null
                                    ? 'Session: ${sessionId.substring(0, 8)}…'
                                    : 'Zero-Knowledge Proof Verified',
                                style: const TextStyle(color: Color(0xFF3FB950), fontSize: 12),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  );
                },
              ),

              const SizedBox(height: 24),

              // ── Quick actions ───────────────────────────────────────────────
              const Text('Quick Actions', style: TextStyle(
                color: Color(0xFF8B949E), fontSize: 12,
                fontWeight: FontWeight.w700, letterSpacing: 0.8,
              )),
              const SizedBox(height: 12),

              GridView.count(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                crossAxisCount: 2,
                crossAxisSpacing: 12,
                mainAxisSpacing: 12,
                childAspectRatio: 1.4,
                children: const [
                  _QuickAction(icon: '📄', label: 'My Documents', subtitle: 'View all credentials', color: Color(0xFF1F6FEB)),
                  _QuickAction(icon: '📷', label: 'Scan & Verify', subtitle: 'Verify a credential', color: Color(0xFF238636)),
                  _QuickAction(icon: '🎓', label: 'MANIT Docs', subtitle: 'Academic credentials', color: Color(0xFF9333EA)),
                  _QuickAction(icon: '🔐', label: 'ZK Proofs', subtitle: 'Selective disclosure', color: Color(0xFFD97706)),
                ],
              ),

              const SizedBox(height: 24),

              // ── Recent documents ────────────────────────────────────────────
              const Text('Recent Documents', style: TextStyle(
                color: Color(0xFF8B949E), fontSize: 12,
                fontWeight: FontWeight.w700, letterSpacing: 0.8,
              )),
              const SizedBox(height: 12),

              _DocumentCard(
                icon: '🎓',
                title: 'MANIT Admission Letter',
                subtitle: 'M.Tech Artificial Intelligence · 2024-26',
                status: 'Verified',
                statusColor: const Color(0xFF4ADE80),
                date: '2024-08-01',
              ),
              const SizedBox(height: 10),
              _DocumentCard(
                icon: '📋',
                title: 'Government ID (ZK Credential)',
                subtitle: 'GovernmentID · did:web:gov.zk-auth.io',
                status: 'Active',
                statusColor: const Color(0xFF388BFD),
                date: '2026-05-03',
              ),

              const SizedBox(height: 24),

              // ── ZK info ─────────────────────────────────────────────────────
              Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: const Color(0xFF0D1117),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: const Color(0xFF21262D)),
                ),
                child: const Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('🛡  How Your Documents are Protected', style: TextStyle(
                      color: Color(0xFFE6EDF3), fontWeight: FontWeight.w700, fontSize: 14,
                    )),
                    SizedBox(height: 10),
                    _InfoRow(icon: '🔑', text: 'Documents stored as cryptographic commitments — not plain text'),
                    SizedBox(height: 6),
                    _InfoRow(icon: '🧮', text: 'Selective disclosure: prove age ≥ 18 without revealing your DOB'),
                    SizedBox(height: 6),
                    _InfoRow(icon: '✅', text: 'Verifiers get YES/NO — zero raw personal data transmitted'),
                    SizedBox(height: 6),
                    _InfoRow(icon: '🔒', text: 'Digital signatures prevent copying and forgery'),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _QuickAction extends StatelessWidget {
  final String icon, label, subtitle;
  final Color  color;
  const _QuickAction({required this.icon, required this.label, required this.subtitle, required this.color});

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(14),
    decoration: BoxDecoration(
      color:        const Color(0xFF0D1117),
      borderRadius: BorderRadius.circular(10),
      border:       Border.all(color: color.withAlpha(60)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(icon, style: const TextStyle(fontSize: 22)),
        const Spacer(),
        Text(label, style: const TextStyle(color: Color(0xFFE6EDF3), fontWeight: FontWeight.w700, fontSize: 13)),
        Text(subtitle, style: const TextStyle(color: Color(0xFF8B949E), fontSize: 10)),
      ],
    ),
  );
}

class _DocumentCard extends StatelessWidget {
  final String icon, title, subtitle, status, date;
  final Color  statusColor;
  const _DocumentCard({
    required this.icon, required this.title, required this.subtitle,
    required this.status, required this.statusColor, required this.date,
  });

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(14),
    decoration: BoxDecoration(
      color:        const Color(0xFF0D1117),
      borderRadius: BorderRadius.circular(10),
      border:       Border.all(color: const Color(0xFF21262D)),
    ),
    child: Row(
      children: [
        Container(
          width: 44, height: 44,
          decoration: BoxDecoration(
            color: const Color(0xFF161B22),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Center(child: Text(icon, style: const TextStyle(fontSize: 22))),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: const TextStyle(color: Color(0xFFE6EDF3), fontWeight: FontWeight.w600, fontSize: 13)),
              Text(subtitle, style: const TextStyle(color: Color(0xFF8B949E), fontSize: 11), overflow: TextOverflow.ellipsis),
              const SizedBox(height: 4),
              Row(children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: statusColor.withAlpha(30),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(status, style: TextStyle(color: statusColor, fontSize: 10, fontWeight: FontWeight.w700)),
                ),
                const Spacer(),
                Text(date, style: const TextStyle(color: Color(0xFF484F58), fontSize: 10)),
              ]),
            ],
          ),
        ),
        const Icon(Icons.chevron_right, color: Color(0xFF484F58), size: 18),
      ],
    ),
  );
}

class _InfoRow extends StatelessWidget {
  final String icon, text;
  const _InfoRow({required this.icon, required this.text});
  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(icon, style: const TextStyle(fontSize: 14)),
      const SizedBox(width: 8),
      Expanded(child: Text(text, style: const TextStyle(color: Color(0xFF8B949E), fontSize: 12, height: 1.4))),
    ],
  );
}
