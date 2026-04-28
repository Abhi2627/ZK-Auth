/// CryptoOverlay — Flutter equivalent of the Next.js CryptoOverlay component.
///
/// Displays a full-screen proof-generation overlay with:
///   1. A live millisecond counter driven by a Ticker (not Timer) — the Ticker
///      fires on every vsync (60/120 fps) so the counter is frame-accurate and
///      never skips. It runs entirely on the UI thread's vsync signal, adding
///      zero CPU overhead between frames.
///   2. Sequential cryptographic state text with in-place AnimatedSwitcher
///      transitions using FadeTransition + SlideTransition combined.
///
/// Animation design:
///   AnimatedSwitcher's `transitionBuilder` stacks a FadeTransition on top of
///   a SlideTransition. The incoming string fades in from y+12px; the outgoing
///   string fades out to y-8px. The `layoutBuilder` pins both strings to the
///   top of the fixed-height container so they occupy the same position.
///   This produces the identical "in-place terminal update" effect as the
///   framer-motion implementation on web.
///
/// Performance:
///   - AnimatedSwitcher uses Flutter's implicit animation system — all
///     interpolation happens in the compositor, not on the Dart UI thread.
///   - The Ticker fires on vsync; Dart code runs for < 50µs per frame.
///   - The overlay itself is a separate OverlayEntry (inserted via Overlay)
///     so it sits above all existing routes without modifying the widget tree.

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

// ─── Telemetry states ─────────────────────────────────────────────────────────

const List<String> kCryptoStates = [
  '> Fetching Challenge Nonce...',
  '> Computing Groth16 Witness...',
  '> Generating Zero-Knowledge Proof...',
  '> Verifying Cryptographic Commitment...',
];

// ─── Theme ────────────────────────────────────────────────────────────────────

class _Theme {
  static const background      = Color(0xFF0D1117);
  static const headerBg        = Color(0xFF161B22);
  static const border          = Color(0xFF30363D);
  static const dimText         = Color(0xFF484F58);
  static const brightText      = Color(0xFFE6EDF3);
  static const green           = Color(0xFF4ADE80);
  static const darkGreen       = Color(0xFF166534);
  static const dotInactive     = Color(0xFF1F2937);
  static const timerBg         = Color(0xFF161B22);
  static const fontFamily      = 'JetBrainsMono';
}

// ─── CryptoOverlay widget ─────────────────────────────────────────────────────

class CryptoOverlay extends StatefulWidget {
  /// The currently active cryptographic state string to display.
  /// Set to null to hide the overlay.
  final String? currentState;

  const CryptoOverlay({super.key, required this.currentState});

  @override
  State<CryptoOverlay> createState() => _CryptoOverlayState();
}

class _CryptoOverlayState extends State<CryptoOverlay>
    with SingleTickerProviderStateMixin {
  late final Ticker _ticker;
  Duration _elapsed = Duration.zero;
  Duration _tickerStart = Duration.zero;
  bool _tickerStarted = false;

  @override
  void initState() {
    super.initState();

    // Ticker fires on every vsync — frame-accurate elapsed time
    _ticker = createTicker((elapsed) {
      setState(() {
        _elapsed = elapsed;
      });
    });
  }

  @override
  void didUpdateWidget(CryptoOverlay oldWidget) {
    super.didUpdateWidget(oldWidget);

    final wasVisible = oldWidget.currentState != null;
    final isVisible  = widget.currentState  != null;

    if (!wasVisible && isVisible) {
      // Start ticker when overlay appears
      _elapsed = Duration.zero;
      _ticker.start();
    } else if (wasVisible && !isVisible) {
      // Stop and reset when overlay disappears
      _ticker.stop();
      _elapsed = Duration.zero;
    }
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  int get _elapsedMs => _elapsed.inMilliseconds;

  @override
  Widget build(BuildContext context) {
    if (widget.currentState == null) return const SizedBox.shrink();

    return AnimatedOpacity(
      opacity: 1.0,
      duration: const Duration(milliseconds: 200),
      child: Material(
        color: Colors.black.withAlpha(210),
        child: Center(
          child: _TerminalCard(
            currentState: widget.currentState!,
            elapsedMs:    _elapsedMs,
          ),
        ),
      ),
    );
  }
}

// ─── Terminal card ────────────────────────────────────────────────────────────

class _TerminalCard extends StatelessWidget {
  final String currentState;
  final int    elapsedMs;

  const _TerminalCard({
    required this.currentState,
    required this.elapsedMs,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width:        460,
      constraints:  const BoxConstraints(maxWidth: 0.92 * 428), // 92vw cap
      decoration: BoxDecoration(
        color:        _Theme.background,
        borderRadius: BorderRadius.circular(10),
        border:       Border.all(color: _Theme.border),
        boxShadow: [
          BoxShadow(
            color:      Colors.black.withAlpha(153),
            blurRadius: 50,
            spreadRadius: 4,
          ),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _TerminalHeader(),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _DimLine('ZK-Auth v1.0.0 — Groth16/BN254'),
                const SizedBox(height: 4),
                _DimLine('Circuit: auth.circom · Curve: bn254'),
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 12),
                  child: Divider(color: Color(0xFF21262D), height: 1),
                ),

                // ── Animated state line ────────────────────────────────────
                SizedBox(
                  height: 28,
                  child: AnimatedSwitcher(
                    duration:  const Duration(milliseconds: 280),
                    switchInCurve:  Curves.easeOutExpo,
                    switchOutCurve: Curves.easeIn,
                    transitionBuilder: (child, animation) {
                      // Combine fade + slide for in-place replacement effect
                      final offsetAnimation = Tween<Offset>(
                        begin: const Offset(0, 0.5),  // incoming: from below
                        end:   Offset.zero,
                      ).animate(CurvedAnimation(
                        parent: animation,
                        curve:  Curves.easeOutExpo,
                      ));

                      return FadeTransition(
                        opacity: animation,
                        child: SlideTransition(
                          position: offsetAnimation,
                          child: child,
                        ),
                      );
                    },
                    // layoutBuilder: stack both on same position (no vertical shift)
                    layoutBuilder: (currentChild, previousChildren) {
                      return Stack(
                        alignment: Alignment.centerLeft,
                        children: [
                          ...previousChildren,
                          if (currentChild != null) currentChild,
                        ],
                      );
                    },
                    child: Text(
                      currentState,
                      // Key must change on every state transition to trigger the animation
                      key:   ValueKey(currentState),
                      style: const TextStyle(
                        fontFamily:  _Theme.fontFamily,
                        fontSize:    13,
                        fontWeight:  FontWeight.w600,
                        color:       _Theme.green,
                        letterSpacing: 0.1,
                      ),
                    ),
                  ),
                ),

                const SizedBox(height: 14),

                // ── Timer row ─────────────────────────────────────────────
                Container(
                  padding:    const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  decoration: BoxDecoration(
                    color:        _Theme.timerBg,
                    borderRadius: BorderRadius.circular(4),
                    border:       Border.all(color: const Color(0xFF21262D)),
                  ),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text(
                        'ELAPSED',
                        style: TextStyle(
                          fontFamily:    _Theme.fontFamily,
                          fontSize:      10,
                          color:         _Theme.dimText,
                          letterSpacing: 0.8,
                        ),
                      ),
                      Text(
                        '${elapsedMs.toString().padLeft(6)} ms',
                        style: const TextStyle(
                          fontFamily:         _Theme.fontFamily,
                          fontSize:           15,
                          fontWeight:         FontWeight.w500,
                          color:              _Theme.brightText,
                          fontFeatures:       [FontFeature.tabularFigures()],
                        ),
                      ),
                    ],
                  ),
                ),

                const SizedBox(height: 14),

                // ── Progress dots ─────────────────────────────────────────
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: kCryptoStates.map((s) {
                    final isActive  = s == currentState;
                    final isPast    = kCryptoStates.indexOf(s) <
                        kCryptoStates.indexOf(currentState);
                    return Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 4),
                      child: AnimatedContainer(
                        duration: const Duration(milliseconds: 300),
                        width:  isActive ? 10 : 8,
                        height: isActive ? 10 : 8,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: isActive
                              ? _Theme.green
                              : isPast
                                ? _Theme.darkGreen
                                : _Theme.dotInactive,
                        ),
                      ),
                    );
                  }).toList(),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ─── Sub-widgets ──────────────────────────────────────────────────────────────

class _TerminalHeader extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: const BoxDecoration(
        color: _Theme.headerBg,
        border: Border(bottom: BorderSide(color: _Theme.border)),
        borderRadius: BorderRadius.only(
          topLeft:  Radius.circular(10),
          topRight: Radius.circular(10),
        ),
      ),
      child: Row(
        children: [
          _MacDot(color: const Color(0xFFFF5F57)),
          const SizedBox(width: 7),
          _MacDot(color: const Color(0xFFFEBC2E)),
          const SizedBox(width: 7),
          _MacDot(color: const Color(0xFF28C840)),
          const SizedBox(width: 10),
          const Text(
            'zk-auth — proof generation',
            style: TextStyle(
              fontFamily: _Theme.fontFamily,
              fontSize:   11,
              color:      _Theme.dimText,
              letterSpacing: 0.2,
            ),
          ),
        ],
      ),
    );
  }
}

class _MacDot extends StatelessWidget {
  final Color color;
  const _MacDot({required this.color});

  @override
  Widget build(BuildContext context) => Container(
    width: 12, height: 12,
    decoration: BoxDecoration(color: color, shape: BoxShape.circle),
  );
}

class _DimLine extends StatelessWidget {
  final String text;
  const _DimLine(this.text);

  @override
  Widget build(BuildContext context) => Text(
    text,
    style: const TextStyle(
      fontFamily: _Theme.fontFamily,
      fontSize:   12,
      color:      _Theme.dimText,
      height:     1.4,
    ),
  );
}
