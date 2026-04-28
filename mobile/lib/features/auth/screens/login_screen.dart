import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../bloc/auth_bloc.dart';
import '../../../core/telemetry/ws_telemetry.dart';
import '../screens/step_up_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  @override
  void initState() {
    super.initState();
    // Subscribe to WS step-up events
    final ws = context.read<WsTelemetryService>();
    ws.incomingMessages.listen((msg) {
      if (msg.type == 'STEP_UP_REQUIRED' && mounted) {
        final payload = msg.payload as Map<String, dynamic>;
        context.read<AuthBloc>().add(AuthStepUpRequired(
          level:     payload['required_level'] as String,
          expiresAt: payload['expires_at']     as int,
        ));
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<AuthBloc, AuthState>(
      listener: (context, state) {
        if (state is AuthAuthenticated) {
          context.go('/dashboard');
        }
        if (state is AuthStepUpPending) {
          // Show step-up overlay as a full-screen dialog
          showDialog<void>(
            context: context,
            barrierDismissible: false,
            barrierColor: Colors.black87,
            builder: (_) => BlocProvider.value(
              value: context.read<AuthBloc>(),
              child: StepUpScreen(
                level:     state.level,
                expiresAt: state.expiresAt,
              ),
            ),
          );
        }
      },
      builder: (context, state) {
        return Scaffold(
          body: SafeArea(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 32.0),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // Logo / title
                  const Icon(Icons.lock_outline, size: 64, color: Color(0xFF4F46E5)),
                  const SizedBox(height: 24),
                  Text(
                    'ZK-Auth',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.headlineLarge?.copyWith(
                          fontWeight: FontWeight.bold,
                        ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Passwordless zero-knowledge authentication',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: Colors.grey,
                        ),
                  ),
                  const SizedBox(height: 48),

                  // Status indicator
                  if (state is AuthError)
                    Container(
                      padding: const EdgeInsets.all(12),
                      margin: const EdgeInsets.only(bottom: 16),
                      decoration: BoxDecoration(
                        color: Colors.red.shade50,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: Colors.red.shade200),
                      ),
                      child: Text(
                        (state as AuthError).message,
                        style: TextStyle(color: Colors.red.shade700),
                        textAlign: TextAlign.center,
                      ),
                    ),

                  if (state is AuthNoSecret) ...[
                    const Text(
                      'No secret key found on this device.',
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 16),
                    // Phase 7: generate + save secret on device
                    OutlinedButton(
                      onPressed: () {
                        context.read<AuthBloc>().add(const AuthRegisterDevice());
                      },
                      child: const Text('Register New Device'),
                    ),
                  ] else ...[
                    _AuthButton(state: state),
                  ],

                  // Step indicator
                  if (state is AuthChallenging ||
                      state is AuthProving ||
                      state is AuthSubmitting)
                    Padding(
                      padding: const EdgeInsets.only(top: 16),
                      child: Text(
                        _statusText(state),
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: Colors.grey),
                      ),
                    ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  String _statusText(AuthState state) {
    if (state is AuthChallenging) return 'Fetching challenge…';
    if (state is AuthProving)     return 'Generating zero-knowledge proof…';
    if (state is AuthSubmitting)  return 'Verifying proof…';
    return '';
  }
}

class _AuthButton extends StatelessWidget {
  final AuthState state;
  const _AuthButton({required this.state});

  @override
  Widget build(BuildContext context) {
    final isLoading = state is AuthChallenging ||
        state is AuthProving ||
        state is AuthSubmitting;

    return ElevatedButton(
      style: ElevatedButton.styleFrom(
        backgroundColor: const Color(0xFF4F46E5),
        foregroundColor: Colors.white,
        padding: const EdgeInsets.symmetric(vertical: 16),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
      onPressed: isLoading
          ? null
          : () => context.read<AuthBloc>().add(const AuthLoginRequested()),
      child: isLoading
          ? const SizedBox(
              height: 20,
              width: 20,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: Colors.white,
              ),
            )
          : const Text('Authenticate', style: TextStyle(fontSize: 16)),
    );
  }
}
