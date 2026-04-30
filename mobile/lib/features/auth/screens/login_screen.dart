/// LoginScreen — ZK-Auth mobile authentication entry point.
///
/// States handled:
///   AuthNoSecret     → Show "Register This Device" (first time)
///   AuthRegistering  → Show spinner "Generating secret key…"
///   AuthRegistered   → Show success + "Continue to Login" button
///   AuthIdle/Error   → Show "Authenticate with ZKP" button
///   AuthChallenging/Proving/Submitting → Show progress steps
///   AuthAuthenticated → Navigate to /dashboard
///   AuthLoggedOut    → Reset to idle

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../bloc/auth_bloc.dart';

class LoginScreen extends StatelessWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<AuthBloc, AuthState>(
      listener: (context, state) {
        if (state is AuthAuthenticated) {
          context.go('/dashboard');
        }
        if (state is AuthLoggedOut) {
          // Already on login screen, just reset
        }
      },
      builder: (context, state) {
        return Scaffold(
          backgroundColor: const Color(0xFF010409),
          body: SafeArea(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 40),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const SizedBox(height: 40),

                  // ── Logo ──────────────────────────────────────────────────
                  Center(
                    child: Container(
                      width: 80, height: 80,
                      decoration: BoxDecoration(
                        gradient: const LinearGradient(
                          begin: Alignment.topLeft,
                          end:   Alignment.bottomRight,
                          colors: [Color(0xFF1F6FEB), Color(0xFF388BFD)],
                        ),
                        borderRadius: BorderRadius.circular(20),
                        boxShadow: [
                          BoxShadow(
                            color:      const Color(0xFF1F6FEB).withAlpha(80),
                            blurRadius: 30,
                            spreadRadius: 2,
                          ),
                        ],
                      ),
                      child: const Center(
                        child: Text(
                          'ZK',
                          style: TextStyle(
                            color:       Colors.white,
                            fontSize:    30,
                            fontWeight:  FontWeight.w900,
                            letterSpacing: -1,
                          ),
                        ),
                      ),
                    ),
                  ),

                  const SizedBox(height: 28),

                  const Text(
                    'ZK-Auth',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color:       Color(0xFFE6EDF3),
                      fontSize:    28,
                      fontWeight:  FontWeight.w800,
                      letterSpacing: -0.5,
                    ),
                  ),

                  const SizedBox(height: 8),

                  const Text(
                    'Passwordless · Zero-Knowledge · Secure',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color:    Color(0xFF8B949E),
                      fontSize: 13,
                      letterSpacing: 0.2,
                    ),
                  ),

                  const SizedBox(height: 52),

                  // ── Main content based on state ───────────────────────────
                  _buildBody(context, state),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _buildBody(BuildContext context, AuthState state) {

    // ── First time: no secret on device ───────────────────────────────────
    if (state is AuthNoSecret) {
      return _RegisterPanel(
        onRegister: () =>
            context.read<AuthBloc>().add(const AuthRegisterDevice()),
      );
    }

    // ── Generating secret ─────────────────────────────────────────────────
    if (state is AuthRegistering) {
      return const _ProgressPanel(
        step: 'Generating cryptographic secret…',
        subSteps: [
          _SubStep(label: 'Generating 256-bit secret key', done: false),
          _SubStep(label: 'Computing ZK commitment',       done: false),
          _SubStep(label: 'Registering with server',       done: false),
        ],
      );
    }

    // ── Registered successfully ───────────────────────────────────────────
    if (state is AuthRegistered) {
      return _RegistrationSuccess(
        commitmentHash: state.commitmentHash,
        onContinue: () =>
            context.read<AuthBloc>().add(const AuthLoginRequested()),
      );
    }

    // ── Logging in ───────────────────────────────────────────────────────
    if (state is AuthChallenging) {
      return const _ProgressPanel(
        step: 'Fetching challenge nonce…',
        subSteps: [
          _SubStep(label: 'Fetching challenge nonce', done: false),
          _SubStep(label: 'Generating ZK proof',      done: false),
          _SubStep(label: 'Verifying proof',          done: false),
        ],
      );
    }

    if (state is AuthProving) {
      return const _ProgressPanel(
        step: 'Generating zero-knowledge proof…',
        subSteps: [
          _SubStep(label: 'Fetching challenge nonce', done: true),
          _SubStep(label: 'Generating ZK proof',      done: false),
          _SubStep(label: 'Verifying proof',          done: false),
        ],
      );
    }

    if (state is AuthSubmitting) {
      return const _ProgressPanel(
        step: 'Verifying proof on server…',
        subSteps: [
          _SubStep(label: 'Fetching challenge nonce', done: true),
          _SubStep(label: 'Generating ZK proof',      done: true),
          _SubStep(label: 'Verifying proof',          done: false),
        ],
      );
    }

    // ── Error ─────────────────────────────────────────────────────────────
    if (state is AuthError) {
      return Column(
        children: [
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color:        const Color(0xFF450A0A),
              borderRadius: BorderRadius.circular(10),
              border:       Border.all(color: const Color(0xFF6E1F1F)),
            ),
            child: Row(
              children: [
                const Text('❌', style: TextStyle(fontSize: 18)),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    state.message,
                    style: const TextStyle(color: Color(0xFFF87171), fontSize: 13),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          _LoginButton(
            onPressed: () =>
                context.read<AuthBloc>().add(const AuthLoginRequested()),
          ),
          const SizedBox(height: 12),
          TextButton(
            onPressed: () =>
                context.read<AuthBloc>().add(const AuthRegisterDevice()),
            child: const Text(
              'Reset — Generate New Device Key',
              style: TextStyle(color: Color(0xFF8B949E), fontSize: 13),
            ),
          ),
        ],
      );
    }

    // ── Default: idle, show login button ─────────────────────────────────
    return Column(
      children: [
        // ZK explanation card
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color:        const Color(0xFF0D1117),
            borderRadius: BorderRadius.circular(10),
            border:       Border.all(color: const Color(0xFF21262D)),
          ),
          child: Column(
            children: [
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: const Color(0xFF0D2149),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: const Text('🔐', style: TextStyle(fontSize: 20)),
                  ),
                  const SizedBox(width: 12),
                  const Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Zero-Knowledge Login',
                          style: TextStyle(
                            color:      Color(0xFFE6EDF3),
                            fontWeight: FontWeight.w700,
                            fontSize:   14,
                          ),
                        ),
                        SizedBox(height: 2),
                        Text(
                          'No password ever sent to any server',
                          style: TextStyle(
                            color:    Color(0xFF8B949E),
                            fontSize: 12,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              const Divider(color: Color(0xFF21262D), height: 1),
              const SizedBox(height: 14),
              _InfoRow(icon: '🔑', text: 'Your secret key lives on this device only'),
              const SizedBox(height: 8),
              _InfoRow(icon: '🧮', text: 'A ZK proof is generated locally'),
              const SizedBox(height: 8),
              _InfoRow(icon: '✅', text: 'Server verifies the proof — never the secret'),
            ],
          ),
        ),

        const SizedBox(height: 24),

        _LoginButton(
          onPressed: () =>
              context.read<AuthBloc>().add(const AuthLoginRequested()),
        ),
      ],
    );
  }
}

// ─── Register panel ───────────────────────────────────────────────────────────

class _RegisterPanel extends StatelessWidget {
  final VoidCallback onRegister;
  const _RegisterPanel({required this.onRegister});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        // Welcome card
        Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            color:        const Color(0xFF0D1117),
            borderRadius: BorderRadius.circular(12),
            border:       Border.all(color: const Color(0xFF1F6FEB), width: 1),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                '👋  Welcome to ZK-Auth',
                style: TextStyle(
                  color:      Color(0xFFE6EDF3),
                  fontSize:   18,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 10),
              const Text(
                'This is your first time on this device. '
                'ZK-Auth will generate a secret cryptographic key '
                'that lives only on your device.',
                style: TextStyle(
                  color:    Color(0xFF8B949E),
                  fontSize: 13,
                  height:   1.6,
                ),
              ),
              const SizedBox(height: 16),
              const Divider(color: Color(0xFF21262D)),
              const SizedBox(height: 16),
              _RegisterRow(
                step: '1',
                text: 'A 32-byte random secret is generated on-device',
              ),
              const SizedBox(height: 10),
              _RegisterRow(
                step: '2',
                text: 'A cryptographic commitment is computed from the secret',
              ),
              const SizedBox(height: 10),
              _RegisterRow(
                step: '3',
                text: 'Only the commitment is sent to the server — secret stays here',
              ),
              const SizedBox(height: 10),
              _RegisterRow(
                step: '4',
                text: 'Future logins use ZK proofs — no password, ever',
              ),
            ],
          ),
        ),

        const SizedBox(height: 24),

        // Warning box
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color:        const Color(0xFF1C1408),
            borderRadius: BorderRadius.circular(8),
            border:       Border.all(color: const Color(0xFF7D4E17)),
          ),
          child: const Row(
            children: [
              Text('⚠️', style: TextStyle(fontSize: 16)),
              SizedBox(width: 10),
              Expanded(
                child: Text(
                  'If you uninstall the app or lose this device, '
                  'you will need your 24-word recovery phrase.',
                  style: TextStyle(color: Color(0xFFFBBC2E), fontSize: 12, height: 1.5),
                ),
              ),
            ],
          ),
        ),

        const SizedBox(height: 24),

        SizedBox(
          height: 52,
          child: ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF1F6FEB),
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
            onPressed: onRegister,
            child: const Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text('🔐', style: TextStyle(fontSize: 18)),
                SizedBox(width: 10),
                Text(
                  'Register This Device',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _RegisterRow extends StatelessWidget {
  final String step;
  final String text;
  const _RegisterRow({required this.step, required this.text});

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 22, height: 22,
          decoration: const BoxDecoration(
            color: Color(0xFF1F6FEB),
            shape: BoxShape.circle,
          ),
          child: Center(
            child: Text(
              step,
              style: const TextStyle(
                color:      Colors.white,
                fontSize:   11,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            text,
            style: const TextStyle(color: Color(0xFFC9D1D9), fontSize: 13, height: 1.5),
          ),
        ),
      ],
    );
  }
}

// ─── Registration success ─────────────────────────────────────────────────────

class _RegistrationSuccess extends StatelessWidget {
  final String     commitmentHash;
  final VoidCallback onContinue;
  const _RegistrationSuccess({
    required this.commitmentHash,
    required this.onContinue,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            color:        const Color(0xFF0A1D0F),
            borderRadius: BorderRadius.circular(12),
            border:       Border.all(color: const Color(0xFF238636)),
          ),
          child: Column(
            children: [
              const Text('✅', style: TextStyle(fontSize: 48)),
              const SizedBox(height: 14),
              const Text(
                'Device Registered',
                style: TextStyle(
                  color:      Color(0xFF4ADE80),
                  fontSize:   20,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                'Your secret key has been securely generated '
                'and stored on this device.',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color:    Color(0xFF3FB950),
                  fontSize: 13,
                  height:   1.6,
                ),
              ),
              const SizedBox(height: 16),
              const Divider(color: Color(0xFF1A4028)),
              const SizedBox(height: 14),
              Row(
                children: [
                  const Text(
                    'Commitment:',
                    style: TextStyle(color: Color(0xFF8B949E), fontSize: 11),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: GestureDetector(
                      onTap: () {
                        Clipboard.setData(ClipboardData(text: commitmentHash));
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(
                            content: Text('Commitment hash copied'),
                            duration: Duration(seconds: 2),
                          ),
                        );
                      },
                      child: Text(
                        '${commitmentHash.substring(0, 12)}…',
                        style: const TextStyle(
                          color:      Color(0xFF4ADE80),
                          fontFamily: 'monospace',
                          fontSize:   11,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),

        const SizedBox(height: 20),

        SizedBox(
          height: 52,
          child: ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF238636),
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
            onPressed: onContinue,
            child: const Text(
              'Continue to Login →',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
            ),
          ),
        ),
      ],
    );
  }
}

// ─── Progress panel ───────────────────────────────────────────────────────────

class _SubStep {
  final String label;
  final bool   done;
  const _SubStep({required this.label, required this.done});
}

class _ProgressPanel extends StatelessWidget {
  final String         step;
  final List<_SubStep> subSteps;
  const _ProgressPanel({required this.step, required this.subSteps});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            color:        const Color(0xFF0D1117),
            borderRadius: BorderRadius.circular(12),
            border:       Border.all(color: const Color(0xFF21262D)),
          ),
          child: Column(
            children: [
              const SizedBox(
                width: 40, height: 40,
                child: CircularProgressIndicator(
                  strokeWidth: 3,
                  color: Color(0xFF388BFD),
                ),
              ),
              const SizedBox(height: 16),
              Text(
                step,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  color:      Color(0xFF79C0FF),
                  fontSize:   14,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 20),
              ...subSteps.map((s) => Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(
                  children: [
                    SizedBox(
                      width: 20, height: 20,
                      child: s.done
                          ? const Icon(Icons.check_circle,
                              color: Color(0xFF4ADE80), size: 18)
                          : const SizedBox(
                              width: 16, height: 16,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Color(0xFF388BFD),
                              ),
                            ),
                    ),
                    const SizedBox(width: 10),
                    Text(
                      s.label,
                      style: TextStyle(
                        color:    s.done
                            ? const Color(0xFF4ADE80)
                            : const Color(0xFFC9D1D9),
                        fontSize: 13,
                      ),
                    ),
                  ],
                ),
              )),
            ],
          ),
        ),
      ],
    );
  }
}

// ─── Login button ─────────────────────────────────────────────────────────────

class _LoginButton extends StatelessWidget {
  final VoidCallback onPressed;
  const _LoginButton({required this.onPressed});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 52,
      child: ElevatedButton(
        style: ElevatedButton.styleFrom(
          backgroundColor: const Color(0xFF1F6FEB),
          foregroundColor: Colors.white,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        ),
        onPressed: onPressed,
        child: const Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text('🔐', style: TextStyle(fontSize: 18)),
            SizedBox(width: 10),
            Text(
              'Authenticate with ZKP',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
            ),
          ],
        ),
      ),
    );
  }
}

// ─── Info row ─────────────────────────────────────────────────────────────────

class _InfoRow extends StatelessWidget {
  final String icon;
  final String text;
  const _InfoRow({required this.icon, required this.text});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Text(icon, style: const TextStyle(fontSize: 16)),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            text,
            style: const TextStyle(color: Color(0xFF8B949E), fontSize: 13),
          ),
        ),
      ],
    );
  }
}
