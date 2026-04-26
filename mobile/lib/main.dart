import 'package:flutter/material.dart';

void main() {
  runApp(const ZkAuthApp());
}

class ZkAuthApp extends StatelessWidget {
  const ZkAuthApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'ZK-Auth',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.indigo),
        useMaterial3: true,
      ),
      // Phase 3: replace with GoRouter + BLoC-driven navigation
      home: const Scaffold(
        body: Center(child: Text('ZK-Auth Mobile — Phase 3')),
      ),
    );
  }
}
