/// Application configuration — API endpoints and environment settings.
///
/// For development:
///   - Run: flutter run -d DEVICE_ID --dart-define=API_HOST=192.168.x.x
///   - Or:  flutter run -d emulator-5554 --dart-define=API_HOST=10.0.2.2
///
/// For production:
///   - Configure via your CI/CD pipeline or app config service

class AppConfig {
  /// API host — set via --dart-define=API_HOST during build
  /// Defaults to localhost (for testing), but should be overridden for real devices
  static const String apiHost = String.fromEnvironment(
    'API_HOST',
    defaultValue: 'localhost', // Change this when running on real device
  );

  /// API port
  static const int apiPort = 3001;

  /// WebSocket host — typically same as API host
  static const String wsHost = String.fromEnvironment(
    'WS_HOST',
    defaultValue: apiHost,
  );

  /// Construct full API base URL
  static String get apiBaseUrl {
    return 'http://$apiHost:$apiPort/api/v1';
  }

  /// Construct full WebSocket URL
  static String get wsBaseUrl {
    return 'ws://$wsHost:$apiPort/api/v1/session/telemetry';
  }

  /// Emulator special case: Android emulator uses 10.0.2.2 to reach host
  static const String androidEmulatorHost = '10.0.2.2';
}
