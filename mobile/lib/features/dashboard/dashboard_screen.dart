import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../auth/bloc/auth_bloc.dart';

class DashboardScreen extends StatelessWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocListener<AuthBloc, AuthState>(
      listener: (context, state) {
        if (state is AuthLoggedOut || state is AuthNoSecret) {
          context.go('/login');
        }
      },
      child: Scaffold(
        backgroundColor: const Color(0xFF010409),
        appBar: AppBar(
          backgroundColor: const Color(0xFF0D1117),
          foregroundColor: const Color(0xFFE6EDF3),
          title: Row(
            children: [
              Container(
                width: 28, height: 28,
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    colors: [Color(0xFF1F6FEB), Color(0xFF388BFD)],
                  ),
                  borderRadius: BorderRadius.circular(7),
                ),
                child: const Center(
                  child: Text('ZK',
                    style: TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w900)),
                ),
              ),
              const SizedBox(width: 10),
              const Text('ZK-Auth', style: TextStyle(fontWeight: FontWeight.w700)),
            ],
          ),
          actions: [
            IconButton(
              icon: const Icon(Icons.logout_outlined),
              tooltip: 'Logout',
              onPressed: () => context.read<AuthBloc>().add(const AuthLogoutRequested()),
            ),
          ],
        ),
        body: BlocBuilder<AuthBloc, AuthState>(
          builder: (context, state) {
            final sessionId = state is AuthAuthenticated ? state.sessionId : '…';
            return SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // ── Success banner ───────────────────────────────────────
                  Container(
                    padding: const EdgeInsets.all(18),
                    decoration: BoxDecoration(
                      gradient: const LinearGradient(
                        colors: [Color(0xFF0A1D0F), Color(0xFF0D2149)],
                      ),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: const Color(0xFF238636)),
                    ),
                    child: Column(
                      children: [
                        const Text('✅', style: TextStyle(fontSize: 40)),
                        const SizedBox(height: 10),
                        const Text(
                          'Authentication Successful',
                          style: TextStyle(
                            color:      Color(0xFF4ADE80),
                            fontSize:   18,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        const SizedBox(height: 6),
                        const Text(
                          'Zero-knowledge proof verified',
                          style: TextStyle(color: Color(0xFF3FB950), fontSize: 13),
                        ),
                        const SizedBox(height: 14),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                          decoration: BoxDecoration(
                            color:        const Color(0xFF161B22),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Text(
                            'Session: ${sessionId.length > 8 ? sessionId.substring(0, 8) : sessionId}…',
                            style: const TextStyle(
                              color:      Color(0xFF79C0FF),
                              fontFamily: 'monospace',
                              fontSize:   12,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),

                  const SizedBox(height: 20),

                  // ── ZK explanation ───────────────────────────────────────
                  const _InfoCard(
                    icon: '🔐',
                    title: 'How ZK-Auth Works',
                    items: [
                      'Your secret key never left this device',
                      'A Groth16 zero-knowledge proof was generated locally',
                      'The server verified the proof without seeing your secret',
                      'No password was transmitted at any point',
                    ],
                  ),

                  const SizedBox(height: 16),

                  // ── Coming next ──────────────────────────────────────────
                  const _InfoCard(
                    icon: '🚀',
                    title: 'Next Features',
                    items: [
                      'Selective Disclosure — prove age ≥ 18 without revealing DOB',
                      'LSTM Behavioral Biometrics — continuous identity verification',
                      'Credential Vault — W3C Verifiable Credentials',
                      'Three-Actor Ecosystem — Issuer, Holder, Verifier',
                    ],
                  ),
                ],
              ),
            );
          },
        ),
      ),
    );
  }
}

class _InfoCard extends StatelessWidget {
  final String       icon;
  final String       title;
  final List<String> items;
  const _InfoCard({required this.icon, required this.title, required this.items});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color:        const Color(0xFF0D1117),
        borderRadius: BorderRadius.circular(12),
        border:       Border.all(color: const Color(0xFF21262D)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(icon, style: const TextStyle(fontSize: 20)),
              const SizedBox(width: 10),
              Text(
                title,
                style: const TextStyle(
                  color:      Color(0xFFE6EDF3),
                  fontWeight: FontWeight.w700,
                  fontSize:   15,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          ...items.map((item) => Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('•  ', style: TextStyle(color: Color(0xFF388BFD), fontSize: 14)),
                Expanded(
                  child: Text(
                    item,
                    style: const TextStyle(color: Color(0xFF8B949E), fontSize: 13, height: 1.5),
                  ),
                ),
              ],
            ),
          )),
        ],
      ),
    );
  }
}
