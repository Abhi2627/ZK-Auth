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
import 'features/dashboard/dashboard_screen.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Lock to portrait orientation
  await SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
    DeviceOrientation.portraitDown,
  ]);

  // Transparent status bar
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor:           Colors.transparent,
    statusBarIconBrightness:  Brightness.light,
    systemNavigationBarColor: Color(0xFF010409),
  ));

  // Initialise intent queue (SQLite)
  await intentQueue.init();

  runApp(const ZkAuthApp());
}

class ZkAuthApp extends StatelessWidget {
  const ZkAuthApp({super.key});

  @override
  Widget build(BuildContext context) {
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
              authApi:     ctx.read<AuthApi>(),
              storage:     ctx.read<SecureStorage>(),
              wsTelemetry: ctx.read<WsTelemetryService>(),
            )..add(const AuthInitialised()),
          ),
        ],
        child: MaterialApp.router(
          title:              'ZK-Auth',
          debugShowCheckedModeBanner: false,
          theme: ThemeData(
            colorScheme: ColorScheme.fromSeed(
              seedColor:  const Color(0xFF1F6FEB),
              brightness: Brightness.dark,
              surface:    const Color(0xFF0D1117),
              background: const Color(0xFF010409),
            ),
            scaffoldBackgroundColor: const Color(0xFF010409),
            useMaterial3: true,
          ),
          routerConfig: _buildRouter(),
        ),
      ),
    );
  }

  GoRouter _buildRouter() => GoRouter(
    initialLocation: '/splash',
    routes: [
      GoRoute(path: '/splash',    builder: (_, __) => const SplashScreen()),
      GoRoute(path: '/login',     builder: (_, __) => const LoginScreen()),
      GoRoute(path: '/dashboard', builder: (_, __) => const DashboardScreen()),
    ],
  );
}
