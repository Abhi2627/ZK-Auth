/// ZK-Auth HTTP client — Dio wrapper with auth interceptor.
///
/// Features:
///   - Injects Bearer token from SecureStorage on every request.
///   - Automatically retries with a refreshed token on 401.
///   - Converts Dio errors into typed ZkAuthApiException.

import 'package:dio/dio.dart';
import '../storage/secure_storage.dart';

// ─── Exception ────────────────────────────────────────────────────────────────

class ZkAuthApiException implements Exception {
  final String code;
  final String message;
  final String trace;
  final int? statusCode;

  const ZkAuthApiException({
    required this.code,
    required this.message,
    this.trace = '',
    this.statusCode,
  });

  @override
  String toString() => 'ZkAuthApiException($code): $message';
}

// ─── Client ───────────────────────────────────────────────────────────────────

class ZkAuthHttpClient {
  final Dio _dio;
  final SecureStorage _storage;
  bool _isRefreshing = false;

  ZkAuthHttpClient({required SecureStorage secureStorage})
      : _storage = secureStorage,
        _dio = Dio(
          BaseOptions(
            baseUrl: const String.fromEnvironment(
              'API_BASE_URL',
              defaultValue: 'http://localhost:3001/api/v1',
            ),
            connectTimeout: const Duration(seconds: 10),
            receiveTimeout: const Duration(seconds: 30),
            headers: {'Content-Type': 'application/json'},
          ),
        ) {
    _dio.interceptors.add(_AuthInterceptor(_storage, _dio, _getIsRefreshing, _setIsRefreshing));
  }

  bool _getIsRefreshing() => _isRefreshing;
  void _setIsRefreshing(bool v) => _isRefreshing = v;

  Dio get dio => _dio;
}

// ─── Auth Interceptor ─────────────────────────────────────────────────────────

class _AuthInterceptor extends Interceptor {
  final SecureStorage _storage;
  final Dio _dio;
  final bool Function() _getIsRefreshing;
  final void Function(bool) _setIsRefreshing;

  _AuthInterceptor(
    this._storage,
    this._dio,
    this._getIsRefreshing,
    this._setIsRefreshing,
  );

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    final token = await _storage.getAccessToken();
    if (token != null) {
      options.headers['Authorization'] = 'Bearer $token';
    }
    handler.next(options);
  }

  @override
  Future<void> onError(
    DioException err,
    ErrorInterceptorHandler handler,
  ) async {
    if (err.response?.statusCode == 401 && !_getIsRefreshing()) {
      _setIsRefreshing(true);
      try {
        final refreshToken = await _storage.getRefreshToken();
        if (refreshToken == null) throw const ZkAuthApiException(code: 'TOKEN_MISSING', message: 'No refresh token');

        final response = await _dio.post(
          '/auth/refresh',
          data: {'refresh_token': refreshToken},
        );

        final newAccess  = response.data['access_token']  as String;
        final newRefresh = response.data['refresh_token'] as String;

        await Future.wait([
          _storage.saveAccessToken(newAccess),
          _storage.saveRefreshToken(newRefresh),
        ]);

        // Retry original request with new token
        err.requestOptions.headers['Authorization'] = 'Bearer $newAccess';
        final retried = await _dio.fetch<dynamic>(err.requestOptions);
        handler.resolve(retried);
        return;
      } catch (_) {
        await _storage.clearSession();
      } finally {
        _setIsRefreshing(false);
      }
    }

    // Convert to typed exception
    final data = err.response?.data;
    if (data is Map<String, dynamic>) {
      handler.reject(
        DioException(
          requestOptions: err.requestOptions,
          error: ZkAuthApiException(
            code:       data['code']?.toString() ?? 'UNKNOWN',
            message:    data['message']?.toString() ?? err.message ?? 'Request failed',
            trace:      data['trace']?.toString() ?? '',
            statusCode: err.response?.statusCode,
          ),
          response: err.response,
        ),
      );
      return;
    }

    handler.next(err);
  }
}
