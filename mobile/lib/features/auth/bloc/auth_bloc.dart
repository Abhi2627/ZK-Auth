import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/api/auth_api.dart';
import '../../../core/storage/secure_storage.dart';
import '../../../core/telemetry/ws_telemetry.dart';

// ─── Events ───────────────────────────────────────────────────────────────────

abstract class AuthEvent extends Equatable {
  const AuthEvent();
  @override List<Object?> get props => [];
}

class AuthInitialised extends AuthEvent {
  const AuthInitialised();
}

/// User tapped "Register This Device" — generate secret + call /auth/register
class AuthRegisterDevice extends AuthEvent {
  const AuthRegisterDevice();
}

class AuthLoginRequested extends AuthEvent {
  const AuthLoginRequested();
}

class AuthStepUpRequired extends AuthEvent {
  final String level;
  final int    expiresAt;
  const AuthStepUpRequired({required this.level, required this.expiresAt});
  @override List<Object?> get props => [level, expiresAt];
}

class AuthStepUpResolveRequested extends AuthEvent {
  const AuthStepUpResolveRequested();
}

class AuthLogoutRequested extends AuthEvent {
  const AuthLogoutRequested();
}

// ─── States ───────────────────────────────────────────────────────────────────

abstract class AuthState extends Equatable {
  const AuthState();
  @override List<Object?> get props => [];
}

class AuthInitial           extends AuthState { const AuthInitial(); }
class AuthCheckingStorage   extends AuthState { const AuthCheckingStorage(); }
/// No secret on device — show Register flow
class AuthNoSecret          extends AuthState { const AuthNoSecret(); }
/// Secret exists — show Login button
class AuthIdle              extends AuthState { const AuthIdle(); }
/// Generating + storing secret key
class AuthRegistering       extends AuthState { const AuthRegistering(); }
/// Registration succeeded — secret now stored, show Login button
class AuthRegistered        extends AuthState {
  final String commitmentHash;
  const AuthRegistered({required this.commitmentHash});
  @override List<Object?> get props => [commitmentHash];
}
class AuthChallenging       extends AuthState { const AuthChallenging(); }
class AuthProving           extends AuthState { const AuthProving(); }
class AuthSubmitting        extends AuthState { const AuthSubmitting(); }
class AuthAuthenticated     extends AuthState {
  final String sessionId;
  const AuthAuthenticated({required this.sessionId});
  @override List<Object?> get props => [sessionId];
}
class AuthStepUpPending extends AuthState {
  final String level;
  final int    expiresAt;
  const AuthStepUpPending({required this.level, required this.expiresAt});
  @override List<Object?> get props => [level, expiresAt];
}
class AuthStepUpProving extends AuthState { const AuthStepUpProving(); }
class AuthError extends AuthState {
  final String message;
  const AuthError({required this.message});
  @override List<Object?> get props => [message];
}
class AuthLoggedOut extends AuthState { const AuthLoggedOut(); }

// ─── BLoC ─────────────────────────────────────────────────────────────────────

class AuthBloc extends Bloc<AuthEvent, AuthState> {
  final AuthApi            _authApi;
  final SecureStorage      _storage;
  final WsTelemetryService _wsTelemetry;

  AuthBloc({
    required AuthApi authApi,
    required SecureStorage storage,
    required WsTelemetryService wsTelemetry,
  })  : _authApi      = authApi,
        _storage      = storage,
        _wsTelemetry  = wsTelemetry,
        super(const AuthInitial()) {
    on<AuthInitialised>         (_onInitialised);
    on<AuthRegisterDevice>      (_onRegisterDevice);
    on<AuthLoginRequested>      (_onLoginRequested);
    on<AuthStepUpRequired>      (_onStepUpRequired);
    on<AuthStepUpResolveRequested>(_onStepUpResolve);
    on<AuthLogoutRequested>     (_onLogout);
  }

  // ─── Initialise ────────────────────────────────────────────────────────────

  Future<void> _onInitialised(
    AuthInitialised event,
    Emitter<AuthState> emit,
  ) async {
    emit(const AuthCheckingStorage());
    final hasSecret = await _storage.hasSecret();
    emit(hasSecret ? const AuthIdle() : const AuthNoSecret());
  }

  // ─── Register device ───────────────────────────────────────────────────────
  // Flow:
  //   1. Generate 32-byte CSPRNG secret
  //   2. Compute commitment = SHA-256(secret) used as Poseidon stand-in for demo
  //   3. POST /auth/register { commitment_hash, public_key_hex }
  //   4. Save secret to SecureStorage
  //   5. Emit AuthRegistered → UI transitions to Login

  Future<void> _onRegisterDevice(
    AuthRegisterDevice event,
    Emitter<AuthState> emit,
  ) async {
    emit(const AuthRegistering());
    try {
      // 1. Generate secret
      final secretHex = _generateSecretHex();

      // 2. Compute commitment (SHA-256 as decimal — demo Poseidon stand-in)
      final commitmentHex   = _sha256Hex(secretHex);
      final commitmentDecimal = _hexToDecimal(commitmentHex);

      // 3. Register with backend
      await _authApi.register(
        commitmentHash: commitmentDecimal,
        publicKeyHex:   commitmentHex, // use commitment as public key in demo
      );

      // 4. Save secret locally (NEVER sent to server again)
      await _storage.saveSecret(secretHex);

      emit(AuthRegistered(commitmentHash: commitmentDecimal));
    } catch (e) {
      emit(AuthError(message: 'Registration failed: ${e.toString()}'));
    }
  }

  // ─── Login ─────────────────────────────────────────────────────────────────
  // Flow:
  //   1. Fetch challenge nonce from server
  //   2. Generate ZK proof  (demo: SHA-256 mock when WASM unavailable)
  //   3. Submit proof → receive JWT tokens
  //   4. Save tokens, open WS, navigate to dashboard

  Future<void> _onLoginRequested(
    AuthLoginRequested event,
    Emitter<AuthState> emit,
  ) async {
    final secretHex = await _storage.getSecret();
    if (secretHex == null) { emit(const AuthNoSecret()); return; }

    try {
      // Step 1: Fetch challenge
      emit(const AuthChallenging());
      final challenge = await _authApi.fetchChallenge();

      // Step 2: Generate proof
      // For demo: use mock proof (SHA-256 based) when circuit WASM not available
      // Real proof generation requires auth.wasm + auth.zkey in assets
      emit(const AuthProving());
      final mockProof = _buildMockProof(
        nonceHex:  challenge.nonce,
        secretHex: secretHex,
      );

      // Step 3: Submit proof
      emit(const AuthSubmitting());
      final tokens = await _authApi.submitProof(
        challengeId:   challenge.challengeId,
        proof:         mockProof.proof,
        publicSignals: mockProof.publicSignals,
      );

      // Step 4: Persist tokens + open WS
      await Future.wait([
        _storage.saveAccessToken(tokens.accessToken),
        _storage.saveRefreshToken(tokens.refreshToken),
        _storage.saveSessionId(tokens.sessionId),
      ]);

      _wsTelemetry.connect(
        accessToken: tokens.accessToken,
        sessionId:   tokens.sessionId,
      );

      emit(AuthAuthenticated(sessionId: tokens.sessionId));
    } catch (e) {
      emit(AuthError(message: e.toString().replaceAll('Exception: ', '')));
    }
  }

  // ─── Step-up ───────────────────────────────────────────────────────────────

  Future<void> _onStepUpRequired(
    AuthStepUpRequired event,
    Emitter<AuthState> emit,
  ) async {
    emit(AuthStepUpPending(level: event.level, expiresAt: event.expiresAt));
  }

  Future<void> _onStepUpResolve(
    AuthStepUpResolveRequested event,
    Emitter<AuthState> emit,
  ) async {
    final secretHex = await _storage.getSecret();
    if (secretHex == null) { emit(const AuthNoSecret()); return; }

    try {
      emit(const AuthStepUpProving());
      final challenge = await _authApi.fetchStepUpChallenge();
      final mockProof = _buildMockProof(
        nonceHex:  challenge.nonce,
        secretHex: secretHex,
      );
      await _authApi.submitStepUpProof(
        challengeId:   challenge.challengeId,
        proof:         mockProof.proof,
        publicSignals: mockProof.publicSignals,
      );
      final sessionId = await _storage.getSessionId() ?? '';
      emit(AuthAuthenticated(sessionId: sessionId));
    } catch (e) {
      emit(AuthError(message: e.toString()));
    }
  }

  // ─── Logout ────────────────────────────────────────────────────────────────

  Future<void> _onLogout(
    AuthLogoutRequested event,
    Emitter<AuthState> emit,
  ) async {
    _wsTelemetry.disconnect();
    await _authApi.logout().catchError((_) {});
    await _storage.clearSession();
    emit(const AuthLoggedOut());
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  String _generateSecretHex() {
    final rng   = Random.secure();
    final bytes = List<int>.generate(32, (_) => rng.nextInt(256));
    return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }

  String _sha256Hex(String input) {
    final bytes  = utf8.encode(input);
    final digest = sha256.convert(bytes);
    return digest.toString();
  }

  String _hexToDecimal(String hex) {
    // Convert hex string to decimal string (BigInt arithmetic via string ops)
    // Dart doesn't have BigInt.parse(hex) natively for very large numbers,
    // but we can use int parsing for 64-char hex → truncate to fit field
    try {
      // Take first 15 hex chars (60 bits) to stay within safe int range
      // In production: use the `big_integer` package for full BN254 field arithmetic
      final truncated = hex.length > 15 ? hex.substring(0, 15) : hex;
      final value     = int.parse(truncated, radix: 16);
      return value.toString();
    } catch (_) {
      return '123456789012345'; // fallback for demo
    }
  }

  /// Build a mock Groth16 proof structure for demo/testing.
  /// Real proof requires WASM circuit files in assets/.
  /// The backend verifies with snarkjs — this will fail verification
  /// but allows testing the full API flow end-to-end.
  _MockProof _buildMockProof({
    required String nonceHex,
    required String secretHex,
  }) {
    final nullifier = _sha256Hex('$secretHex:$nonceHex');
    final nullifierDecimal = _hexToDecimal(nullifier);
    final commitment = _hexToDecimal(_sha256Hex(secretHex));

    return _MockProof(
      proof: {
        'pi_a': ['1', '2', '1'],
        'pi_b': [['10', '11'], ['12', '13'], ['1', '0']],
        'pi_c': ['4', '5', '1'],
        'protocol': 'groth16',
        'curve': 'bn254',
      },
      publicSignals: [nullifierDecimal, commitment],
    );
  }
}

class _MockProof {
  final Map<String, dynamic> proof;
  final List<String> publicSignals;
  const _MockProof({required this.proof, required this.publicSignals});
}
