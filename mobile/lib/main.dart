import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import 'core/api/auth_api.dart';
import 'core/api/http_client.dart';
import 'core/storage/secure_storage.dart';
import 'core/telemetry/ws_telemetry.dart';
import 'features/auth/bloc/auth_bloc.dart';
import 'features/auth/screens/login_screen.dart';
import 'features/dashboard/dashboard_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const ZkAuthApp());
}

class ZkAuthApp extends StatelessWidget {
  const ZkAuthApp({super.key});

  @override
  Widget build(BuildContext context) {
    // ── Dependency wiring ────────────────────────────────────────────────────
    final secureStorage = SecureStorage();
    final httpClient    = ZkAuthHttpClient(secureStorage: secureStorage);
    final authApi       = AuthApi(client: httpClient);
    final wsTelemetry   = WsTelemetryService();

    return MultiRepositoryProvider(
      providers: [
        RepositoryProvider<SecureStorage>.value(value: secureStorage),
        RepositoryProvider<AuthApi>.value(value: authApi),
        RepositoryProvider<WsTelemetryService>.value(value: wsTelemetry),
      ],
      child: MultiBlocProvider(
        providers: [
          BlocProvider<AuthBloc>(
            create: (ctx) => AuthBloc(
              authApi:      ctx.read<AuthApi>(),
              storage:      ctx.read<SecureStorage>(),
              wsTelemetry:  ctx.read<WsTelemetryService>(),
            )..add(const AuthInitialised()),
          ),
        ],
        child: _AppRouter(),
      ),
    );
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

class _AppRouter extends StatelessWidget {
  _AppRouter();

  late final GoRouter _router = GoRouter(
    initialLocation: '/login',
    routes: [
      GoRoute(
        path: '/login',
        builder: (_, __) => const LoginScreen(),
      ),
      GoRoute(
        path: '/dashboard',
        builder: (_, __) => const DashboardScreen(),
      ),
    ],
    redirect: (context, state) {
      // Auth guard handled by AuthBloc state listener in each screen
      return null;
    },
  );

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'ZK-Auth',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF4F46E5), // Indigo-600
          brightness: Brightness.light,
        ),
        useMaterial3: true,
        fontFamily: 'SF Pro Display',
      ),
      darkTheme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF4F46E5),
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
      ),
      routerConfig: _router,
    );
  }
}
