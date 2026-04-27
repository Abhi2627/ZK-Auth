/// StepUpScreen — Un-dismissible full-screen re-authentication overlay.
///
/// Displayed as a Dialog with barrierDismissible: false.
/// Intercepts the entire screen — the underlying app is inaccessible
/// until re-authentication succeeds or the countdown expires.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../bloc/auth_bloc.dart';

class StepUpScreen extends StatefulWidget {
  final String level;
  final int    expiresAt;

  const StepUpScreen({
    super.key,
    required this.level,
    required this.expiresAt,
  });

  @override
  State<StepUpScreen> createState() => _StepUpScreenState();
}

class _StepUpScreenState extends State<StepUpScreen> {
  Timer? _countdownTimer;
  int    _secondsLeft = 0;

  @override
  void initState() {
    super.initState();
    _updateCountdown();
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      _updateCountdown();
    });
  }

  void _updateCountdown() {
    final remaining =
        ((widget.expiresAt - DateTime.now().millisecondsSinceEpoch) / 1000)
            .ceil()
            .clamp(0, 300);
    setState(() => _secondsLeft = remaining);
    if (remaining == 0 && mounted) {
      // Session expired — dismiss and redirect to login
      Navigator.of(context).pop();
    }
  }

  @override
  void dispose() {
    _countdownTimer?.cancel();
    super.dispose();
  }

  String get _timerText {
    final m = (_secondsLeft ~/ 60).toString().padLeft(2, '0');
    final s = (_secondsLeft  % 60).toString().padLeft(2, '0');
    return '$m:$s';
  }

  @override
  Widget build(BuildContext context) {
    return BlocListener<AuthBloc, AuthState>(
      listener: (context, state) {
        if (state is AuthAuthenticated) {
          Navigator.of(context).pop(); // dismiss dialog — session restored
        }
      },
      child: Dialog(
        backgroundColor: Colors.transparent,
        insetPadding: EdgeInsets.zero,
        child: Container(
          width: double.infinity,
          height: double.infinity,
          color: Colors.black.withAlpha(230),
          child: SafeArea(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 32),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Icon(Icons.security, size: 64, color: Colors.orange),
                  const SizedBox(height: 24),
                  Text(
                    widget.level == 'HARD'
                        ? 'Re-authentication Required'
                        : 'Verify Your Identity',
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 24,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    widget.level == 'HARD'
                        ? 'Unusual activity detected. Please complete '
                          'a zero-knowledge proof to continue.'
                        : 'Elevated risk detected. Confirm your identity.',
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: Colors.white70),
                  ),
                  const SizedBox(height: 32),
                  // Countdown
                  Text(
                    'Time remaining: $_timerText',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: _secondsLeft < 60 ? Colors.red : Colors.white60,
                      fontSize: 16,
                    ),
                  ),
                  const SizedBox(height: 32),

                  BlocBuilder<AuthBloc, AuthState>(
                    builder: (context, state) {
                      final isWorking = state is AuthStepUpProving;

                      if (state is AuthError) {
                        return Column(
                          children: [
                            Text(
                              state.message,
                              style: const TextStyle(color: Colors.redAccent),
                              textAlign: TextAlign.center,
                            ),
                            const SizedBox(height: 16),
                            _ReAuthButton(isWorking: false),
                          ],
                        );
                      }

                      return _ReAuthButton(isWorking: isWorking);
                    },
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ReAuthButton extends StatelessWidget {
  final bool isWorking;
  const _ReAuthButton({required this.isWorking});

  @override
  Widget build(BuildContext context) {
    return ElevatedButton(
      style: ElevatedButton.styleFrom(
        backgroundColor: Colors.orange,
        foregroundColor: Colors.white,
        padding: const EdgeInsets.symmetric(vertical: 16),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
      onPressed: isWorking
          ? null
          : () => context
              .read<AuthBloc>()
              .add(const AuthStepUpResolveRequested()),
      child: isWorking
          ? const Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                SizedBox(
                  height: 18,
                  width:  18,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: Colors.white,
                  ),
                ),
                SizedBox(width: 12),
                Text('Generating proof…'),
              ],
            )
          : const Text('Authenticate with ZKP', style: TextStyle(fontSize: 16)),
    );
  }
}
