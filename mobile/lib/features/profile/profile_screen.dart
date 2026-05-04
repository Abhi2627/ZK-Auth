import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import '../auth/bloc/auth_bloc.dart';

class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF010409),
      appBar: AppBar(title: const Text('Profile')),
      body: BlocBuilder<AuthBloc, AuthState>(
        builder: (context, state) {
          final sessionId = state is AuthAuthenticated ? state.sessionId : '—';
          return SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: Column(
              children: [
                // Avatar
                Container(
                  width: 80, height: 80,
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(
                      colors: [Color(0xFF1F6FEB), Color(0xFF388BFD)],
                    ),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: const Center(
                    child: Text('ZK', style: TextStyle(
                      color: Colors.white, fontSize: 28, fontWeight: FontWeight.w900,
                    )),
                  ),
                ),
                const SizedBox(height: 14),
                const Text('ZK-Auth User', style: TextStyle(
                  color: Color(0xFFE6EDF3), fontWeight: FontWeight.w700, fontSize: 18,
                )),
                const SizedBox(height: 4),
                Text(
                  'Session: ${sessionId.length > 8 ? sessionId.substring(0, 8) : sessionId}…',
                  style: const TextStyle(color: Color(0xFF8B949E), fontSize: 12, fontFamily: 'monospace'),
                ),
                const SizedBox(height: 6),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  decoration: BoxDecoration(
                    color: const Color(0xFF052E16),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: const Text('● ZKP Authenticated', style: TextStyle(
                    color: Color(0xFF4ADE80), fontSize: 11, fontWeight: FontWeight.w600,
                  )),
                ),

                const SizedBox(height: 28),

                // Settings sections
                _Section(title: 'Security', items: [
                  _Item(icon: Icons.key_outlined,          label: 'Secret Key Management'),
                  _Item(icon: Icons.lock_reset_outlined,   label: 'Recovery Phrase'),
                  _Item(icon: Icons.devices_outlined,      label: 'Connected Devices'),
                ]),

                const SizedBox(height: 16),

                _Section(title: 'Documents', items: [
                  _Item(icon: Icons.folder_outlined,       label: 'All Credentials'),
                  _Item(icon: Icons.history,               label: 'Verification History'),
                  _Item(icon: Icons.share_outlined,        label: 'Share Document'),
                ]),

                const SizedBox(height: 16),

                _Section(title: 'About', items: [
                  _Item(icon: Icons.info_outline,          label: 'How ZK-Auth Works'),
                  _Item(icon: Icons.school_outlined,       label: 'ZKP Technology'),
                  _Item(icon: Icons.article_outlined,      label: 'Research Paper'),
                ]),

                const SizedBox(height: 24),

                SizedBox(
                  width: double.infinity,
                  child: OutlinedButton(
                    style: OutlinedButton.styleFrom(
                      foregroundColor: const Color(0xFFF87171),
                      side: const BorderSide(color: Color(0xFF6E1F1F)),
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                    ),
                    onPressed: () => context.read<AuthBloc>().add(const AuthLogoutRequested()),
                    child: const Text('Sign Out', style: TextStyle(fontWeight: FontWeight.w700)),
                  ),
                ),

                const SizedBox(height: 12),

                const Text('ZK-Auth v1.0 · MTech AI Research · MANIT Bhopal',
                  style: TextStyle(color: Color(0xFF484F58), fontSize: 10)),
                const Text('FrontSci 2025 · Groth16 / BN254 / Poseidon',
                  style: TextStyle(color: Color(0xFF484F58), fontSize: 10)),
              ],
            ),
          );
        },
      ),
    );
  }
}

class _Section extends StatelessWidget {
  final String title;
  final List<_Item> items;
  const _Section({required this.title, required this.items});

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Text(title.toUpperCase(), style: const TextStyle(
          color: Color(0xFF484F58), fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 0.8,
        )),
      ),
      Container(
        decoration: BoxDecoration(
          color:        const Color(0xFF0D1117),
          borderRadius: BorderRadius.circular(12),
          border:       Border.all(color: const Color(0xFF21262D)),
        ),
        child: Column(
          children: items.map((item) => ListTile(
            leading:       Icon(item.icon, color: const Color(0xFF388BFD), size: 20),
            title:         Text(item.label, style: const TextStyle(color: Color(0xFFE6EDF3), fontSize: 14)),
            trailing:      const Icon(Icons.chevron_right, color: Color(0xFF484F58), size: 18),
            dense:         true,
            onTap:         () {},
          )).toList(),
        ),
      ),
    ],
  );
}

class _Item {
  final IconData icon;
  final String   label;
  const _Item({required this.icon, required this.label});
}
