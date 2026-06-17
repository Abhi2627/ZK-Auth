import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../auth/bloc/auth_bloc.dart';
import '../vault/vault_screen.dart';
import '../scanner/scanner_screen.dart';
import '../profile/profile_screen.dart';
import '../dashboard/home_screen.dart';
import '../inbox/inbox_screen.dart';
import '../../core/api/http_client.dart';

class HomeShell extends StatefulWidget {
  final Widget child;
  const HomeShell({super.key, required this.child});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _currentIndex = 0;

  @override
  Widget build(BuildContext context) {
    final httpClient = context.read<ZkAuthHttpClient>();

    final pages = <Widget>[
      const HomeScreen(),
      const VaultScreen(),
      const ScannerScreen(),
      InboxScreen(client: httpClient),
      const ProfileScreen(),
    ];

    return BlocListener<AuthBloc, AuthState>(
      listener: (context, state) {
        if (state is AuthLoggedOut || state is AuthNoSecret) {
          context.go('/login');
        }
      },
      child: Scaffold(
        body: IndexedStack(index: _currentIndex, children: pages),
        bottomNavigationBar: Container(
          decoration: const BoxDecoration(
            border: Border(top: BorderSide(color: Color(0xFF21262D))),
          ),
          child: BottomNavigationBar(
            currentIndex: _currentIndex,
            onTap: (i) => setState(() => _currentIndex = i),
            items: const [
              BottomNavigationBarItem(
                icon:       Icon(Icons.home_outlined),
                activeIcon: Icon(Icons.home),
                label:      'Home',
              ),
              BottomNavigationBarItem(
                icon:       Icon(Icons.folder_outlined),
                activeIcon: Icon(Icons.folder),
                label:      'Vault',
              ),
              BottomNavigationBarItem(
                icon:       Icon(Icons.qr_code_scanner_outlined),
                activeIcon: Icon(Icons.qr_code_scanner),
                label:      'Scan',
              ),
              BottomNavigationBarItem(
                icon:       Icon(Icons.inbox_outlined),
                activeIcon: Icon(Icons.inbox),
                label:      'Inbox',
              ),
              BottomNavigationBarItem(
                icon:       Icon(Icons.person_outline),
                activeIcon: Icon(Icons.person),
                label:      'Profile',
              ),
            ],
          ),
        ),
      ),
    );
  }
}
