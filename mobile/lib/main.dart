import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import 'core/api/auth_api.dart';
import 'core/api/http_client.dart';
import 'core/storage/secure_storage.dart';
import 'core/storage/intent_queue.dart';
import 'core/telemetry/ws_telemetry.dart';
import 'features/auth/bloc/auth_bloc.dart';
import 'features/auth/screens/login_screen.dart';
import 'features/auth/screens/splash_screen.dart';
import 'features/home/home_shell.dart';
import 'features/dashboard/home_screen.dart';
import 'features/vault/vault_screen.dart';
import 'features/scanner/scanner_screen.dart';
import 'features/profile/profile_screen.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  await SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
    DeviceOrientation.portraitDown,
  ]);

  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor:                    Colors.transparent,
    statusBarIconBrightness:           Brightness.light,
    systemNavigationBarColor:          Color(0xFF0D1117),
    systemNavigationBarIconBrightness: Brightness.light,
  ));

  await intentQueue.init();
  runApp(const ZkAuthApp());
}

class ZkAuthApp extends StatelessWidget {
  const ZkAuthApp({super.key});

  @override
  Widget build(BuildContext context) {
    final storage     = SecureStorage();
    final httpClient  = ZkAuthHttpClient(secureStorage: storage);
    final authApi     = AuthApi(client: httpClient);
    final wsTelemetry = WsTelemetryService();

    return MultiRepositoryProvider(
      providers: [
        RepositoryProvider<SecureStorage>.value(value: storage),
        RepositoryProvider<AuthApi>.value(value: authApi),
        RepositoryProvider<WsTelemetryService>.value(value: wsTelemetry),
        RepositoryProvider<ZkAuthHttpClient>.value(value: httpClient),
      ],
      child: MultiBlocProvider(
        providers: [
          BlocProvider<AuthBloc>(
            create: (ctx) => AuthBloc(
              authApi:     ctx.read<AuthApi>(),
              storage:     ctx.read<SecureStorage>(),
              wsTelemetry: ctx.read<WsTelemetryService>(),
            )..add(const AuthInitialised()),
          ),
        ],
        child: MaterialApp.router(
          title:                      'ZK-Auth DigiLocker',
          debugShowCheckedModeBanner: false,
          theme:                      _buildTheme(),
          routerConfig:               _buildRouter(),
        ),
      ),
    );
  }

  ThemeData _buildTheme() => ThemeData(
    colorScheme: const ColorScheme.dark(
      primary:    Color(0xFF1F6FEB),
      secondary:  Color(0xFF388BFD),
      surface:    Color(0xFF0D1117),
      onPrimary:  Colors.white,
      onSurface:  Color(0xFFE6EDF3),
    ),
    scaffoldBackgroundColor: const Color(0xFF010409),
    appBarTheme: const AppBarTheme(
      backgroundColor: Color(0xFF0D1117),
      foregroundColor: Color(0xFFE6EDF3),
      elevation:       0,
      titleTextStyle:  TextStyle(
        color: Color(0xFFE6EDF3), fontSize: 18, fontWeight: FontWeight.w700,
      ),
      iconTheme: IconThemeData(color: Color(0xFFE6EDF3)),
    ),
    bottomNavigationBarTheme: const BottomNavigationBarThemeData(
      backgroundColor:     Color(0xFF0D1117),
      selectedItemColor:   Color(0xFF388BFD),
      unselectedItemColor: Color(0xFF484F58),
      type:                BottomNavigationBarType.fixed,
      elevation:           8,
    ),
    useMaterial3: true,
  );

  GoRouter _buildRouter() => GoRouter(
    initialLocation: '/splash',
    routes: [
      GoRoute(path: '/splash', builder: (_, __) => const SplashScreen()),
      GoRoute(path: '/login',  builder: (_, __) => const LoginScreen()),
      ShellRoute(
        builder: (context, state, child) => HomeShell(child: child),
        routes: [
          GoRoute(path: '/home',    builder: (_, __) => const HomeScreen()),
          GoRoute(path: '/vault',   builder: (_, __) => const VaultScreen()),
          GoRoute(path: '/scanner', builder: (_, __) => const ScannerScreen()),
          GoRoute(path: '/profile', builder: (_, __) => const ProfileScreen()),
        ],
      ),
    ],
  );
}
