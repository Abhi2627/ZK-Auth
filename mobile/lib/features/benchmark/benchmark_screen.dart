/// ZK-Auth Mobile Benchmark Screen
///
/// Runs N real Groth16 proof generations on this device and displays
/// latency statistics for the paper (Table I, Mobile row).
library benchmark_screen;

import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart' show defaultTargetPlatform;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/zkp/groth_prover.dart';
import '../../core/zkp/poseidon_bn254.dart';

class BenchmarkScreen extends StatefulWidget {
  const BenchmarkScreen({super.key});

  @override
  State<BenchmarkScreen> createState() => _BenchmarkScreenState();
}

class _BenchmarkScreenState extends State<BenchmarkScreen> {
  final List<String> _log = [];
  bool _running = false;
  Map<String, dynamic>? _results;
  final int _trials = 15;

  void _addLog(String msg) => setState(() => _log.add(msg));

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0f0f0f),
      appBar: AppBar(
        backgroundColor: const Color(0xFF1a1a1a),
        title: const Text('ZK-Auth Mobile Benchmark',
            style: TextStyle(color: Color(0xFF7dd3fc), fontFamily: 'monospace')),
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Measures real Groth16 prove time on this device.\n'
              'Results → Table I (Mobile row) of the paper.',
              style: TextStyle(color: Colors.grey[500], fontSize: 12, fontFamily: 'monospace'),
            ),
            const SizedBox(height: 12),
            Row(children: [
              ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: _running ? Colors.grey[800] : const Color(0xFF1d4ed8),
                  foregroundColor: Colors.white,
                  textStyle: const TextStyle(fontFamily: 'monospace'),
                ),
                onPressed: _running ? null : _runBenchmark,
                child: Text(_running ? 'Running...' : 'Run Benchmark ($_trials trials)'),
              ),
              const SizedBox(width: 12),
              if (_results != null)
                ElevatedButton(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF166534),
                    foregroundColor: Colors.white,
                    textStyle: const TextStyle(fontFamily: 'monospace'),
                  ),
                  onPressed: _copyResults,
                  child: const Text('Copy JSON'),
                ),
            ]),
            const SizedBox(height: 12),
            Expanded(
              child: Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: const Color(0xFF111111),
                  border: Border.all(color: const Color(0xFF333333)),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: ListView.builder(
                  itemCount: _log.length,
                  itemBuilder: (_, i) => Text(
                    _log[i],
                    style: TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 11,
                      color: _log[i].startsWith('ERROR') || _log[i].contains('ERR')
                          ? const Color(0xFFf87171)
                          : _log[i].startsWith('✓') || _log[i].startsWith('DONE')
                              ? const Color(0xFF4ade80)
                              : _log[i].startsWith('──')
                                  ? const Color(0xFF7dd3fc)
                                  : const Color(0xFFd1d5db),
                    ),
                  ),
                ),
              ),
            ),
            if (_results != null) ...[
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: const Color(0xFF052e16),
                  border: Border.all(color: const Color(0xFF22c55e)),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  const Text('Results → Table I (Mobile row)',
                      style: TextStyle(
                          color: Color(0xFF4ade80),
                          fontFamily: 'monospace',
                          fontWeight: FontWeight.bold)),
                  const SizedBox(height: 8),
                  _row('Median wall-clock', '${(_results!['proveTimeWall_ms'] as Map)['median']} ms'),
                  _row('p95', '${(_results!['proveTimeWall_ms'] as Map)['p95']} ms'),
                  _row('Std dev', '${(_results!['proveTimeWall_ms'] as Map)['stddev']} ms'),
                  _row('Min / Max',
                      '${(_results!['proveTimeWall_ms'] as Map)['min']} / '
                      '${(_results!['proveTimeWall_ms'] as Map)['max']} ms'),
                  _row('Success', '${_results!['successCount']}/$_trials'),
                  _row('Device', _results!['device'] as String? ?? '?'),
                ]),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _row(String label, String value) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(children: [
          SizedBox(
            width: 160,
            child: Text(label,
                style: const TextStyle(
                    color: Color(0xFF9ca3af), fontFamily: 'monospace', fontSize: 12)),
          ),
          Text(value,
              style: const TextStyle(
                  color: Colors.white, fontFamily: 'monospace', fontSize: 12,
                  fontWeight: FontWeight.bold)),
        ]),
      );

  Future<void> _runBenchmark() async {
    setState(() { _running = true; _results = null; _log.clear(); });

    final device = defaultTargetPlatform.name;
    _addLog('ZK-Auth Mobile Benchmark — $_trials trials');
    _addLog('Platform: $device');
    _addLog('');

    final rng = Random.secure();
    final secretBytes = List.generate(32, (_) => rng.nextInt(256));
    final secretHex = secretBytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    final secretField = hexToField(secretHex).toString();

    _addLog('Initialising GrothProver...');
    final prover = GrothProver();
    final initSw = Stopwatch()..start();
    try {
      await prover.init();
      initSw.stop();
      _addLog('✓ Ready in ${initSw.elapsedMilliseconds}ms');
    } catch (e) {
      _addLog('ERROR: $e');
      setState(() => _running = false);
      return;
    }

    _addLog('');
    _addLog('trial | wallMs | status');
    _addLog('------+--------+-------');

    final rows = <Map<String, dynamic>>[];

    for (int i = 0; i < _trials; i++) {
      final nonceBytes = List.generate(32, (_) => rng.nextInt(256));
      final nonceHex = nonceBytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
      final nonceField = hexToField(nonceHex).toString();

      try {
        final res = await prover.generateProof(
          secretField: secretField,
          nonceField: nonceField,
        );
        rows.add({'trial': i+1, 'wallMs': res.wallMs, 'status': 'ok'});
        _addLog('${(i+1).toString().padLeft(5)} | ${(res.wallMs ?? 0).toString().padLeft(6)}ms | ok');
      } catch (e) {
        rows.add({'trial': i+1, 'wallMs': null, 'status': 'error'});
        _addLog('${(i+1).toString().padLeft(5)} |    ERR | $e');
      }
    }

    prover.dispose();

    final ok = rows.where((r) => r['status'] == 'ok').toList();
    final times = ok.map((r) => (r['wallMs'] as int).toDouble()).toList()..sort();
    final s = _stats(times);

    _addLog('');
    _addLog('──────────────────────────────────────');
    _addLog('DONE: ${ok.length}/$_trials');
    _addLog('median=${s['median']}ms  p95=${s['p95']}ms  std=${s['stddev']}ms');

    final result = {
      'benchmarkType': 'mobile-webview-groth16',
      'generatedAt': DateTime.now().toIso8601String(),
      'device': device,
      'trials': _trials,
      'successCount': ok.length,
      'initMs': initSw.elapsedMilliseconds,
      'proveTimeWall_ms': s,
      'methodologyNote':
          'wallMs = Dart Stopwatch around GrothProver.generateProof(), '
          'covering snarkjs.groth16.fullProve() inside the hidden WebView '
          'plus JS bridge (postMessage) overhead both ways. '
          'Circuit artifacts loaded as in-memory Uint8Arrays from Flutter assets. '
          'initMs (WebView setup + asset loading) excluded from prove times.',
      'rawTrials': rows,
    };

    setState(() { _results = result; _running = false; });
  }

  Map<String, dynamic> _stats(List<double> s) {
    if (s.isEmpty) return {};
    final n = s.length;
    final mean = s.reduce((a, b) => a + b) / n;
    final variance = s.map((x) => (x-mean)*(x-mean)).reduce((a,b)=>a+b) / n;
    r(double x) => (x * 10).round() / 10;
    pct(double p) => s[min(n-1, (p/100*n).floor())];
    return {
      'n': n, 'mean': r(mean), 'median': r(pct(50)),
      'stddev': r(sqrt(variance)), 'min': r(s.first), 'max': r(s.last),
      'p95': r(pct(95)), 'p99': r(pct(99)),
    };
  }

  void _copyResults() {
    if (_results == null) return;
    Clipboard.setData(ClipboardData(text: const JsonEncoder.withIndent('  ').convert(_results)));
    ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Results JSON copied to clipboard')));
  }
}
