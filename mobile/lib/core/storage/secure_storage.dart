/// SecureStorage — typed wrapper around flutter_secure_storage.
///
/// Key schema:
///   zk_auth_secret        — 64-char hex ZKP secret (registered once)
///   zk_auth_access_token  — short-lived JWT (15m)
///   zk_auth_refresh_token — long-lived JWT (7d)
///   zk_auth_session_id    — current session UUID
///
/// iOS: values stored in Keychain (encrypted at rest by Secure Enclave).
/// Android: values stored in EncryptedSharedPreferences (AES-256-GCM).
/// Neither platform exposes values in device backups by default.

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class SecureStorage {
  final FlutterSecureStorage _store;

  SecureStorage()
      : _store = const FlutterSecureStorage(
          aOptions: AndroidOptions(encryptedSharedPreferences: true),
          iOptions: IOSOptions(
            accessibility: KeychainAccessibility.first_unlock_this_device,
          ),
        );

  // ─── ZKP Secret ────────────────────────────────────────────────────────────

  Future<String?> getSecret() => _store.read(key: 'zk_auth_secret');

  Future<void> saveSecret(String secretHex) =>
      _store.write(key: 'zk_auth_secret', value: secretHex);

  Future<bool> hasSecret() async =>
      (await _store.read(key: 'zk_auth_secret')) != null;

  // ─── Tokens ────────────────────────────────────────────────────────────────

  Future<String?> getAccessToken() =>
      _store.read(key: 'zk_auth_access_token');

  Future<void> saveAccessToken(String token) =>
      _store.write(key: 'zk_auth_access_token', value: token);

  Future<String?> getRefreshToken() =>
      _store.read(key: 'zk_auth_refresh_token');

  Future<void> saveRefreshToken(String token) =>
      _store.write(key: 'zk_auth_refresh_token', value: token);

  Future<String?> getSessionId() =>
      _store.read(key: 'zk_auth_session_id');

  Future<void> saveSessionId(String id) =>
      _store.write(key: 'zk_auth_session_id', value: id);

  // ─── Clear ─────────────────────────────────────────────────────────────────

  /// Clear tokens (on logout). Does NOT clear the ZKP secret.
  Future<void> clearSession() async {
    await Future.wait([
      _store.delete(key: 'zk_auth_access_token'),
      _store.delete(key: 'zk_auth_refresh_token'),
      _store.delete(key: 'zk_auth_session_id'),
    ]);
  }

  /// Full wipe including secret (account removal / factory reset).
  Future<void> clearAll() => _store.deleteAll();
}
