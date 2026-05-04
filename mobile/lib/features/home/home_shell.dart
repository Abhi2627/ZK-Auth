import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../auth/bloc/auth_bloc.dart';
import '../vault/vault_screen.dart';
import '../scanner/scanner_screen.dart';
import '../profile/profile_screen.dart';
import '../dashboard/home_screen.dart';

class HomeShell extends StatefulWidget {
  final Widget child;
  const HomeShell({super.key, required this.child});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _currentIndex = 0;

  final List<Widget> _pages = const [
    HomeScreen(),
    VaultScreen(),
    ScannerScreen(),
    ProfileScreen(),
  ];

  final List<_NavItem> _navItems = const [
    _NavItem(icon: Icons.home_outlined,         activeIcon: Icons.home,            label: 'Home'),
    _NavItem(icon: Icons.folder_outlined,        activeIcon: Icons.folder,          label: 'Vault'),
    _NavItem(icon: Icons.qr_code_scanner,        activeIcon: Icons.qr_code_scanner, label: 'Scan'),
    _NavItem(icon: Icons.person_outline,         activeIcon: Icons.person,          label: 'Profile'),
  ];

  @override
  Widget build(BuildContext context) {
    return BlocListener<AuthBloc, AuthState>(
      listener: (context, state) {
        if (state is AuthLoggedOut || state is AuthNoSecret) {
          context.go('/login');
        }
      },
      child: Scaffold(
        body: IndexedStack(
          index: _currentIndex,
          children: _pages,
        ),
        bottomNavigationBar: Container(
          decoration: const BoxDecoration(
            border: Border(top: BorderSide(color: Color(0xFF21262D))),
          ),
          child: BottomNavigationBar(
            currentIndex: _currentIndex,
            onTap: (i) => setState(() => _currentIndex = i),
            items: _navItems.map((item) => BottomNavigationBarItem(
              icon:       Icon(item.icon),
              activeIcon: Icon(item.activeIcon),
              label:      item.label,
            )).toList(),
          ),
        ),
      ),
    );
  }
}

class _NavItem {
  final IconData icon;
  final IconData activeIcon;
  final String   label;
  const _NavItem({required this.icon, required this.activeIcon, required this.label});
}
