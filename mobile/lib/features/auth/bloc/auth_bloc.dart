import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/api/auth_api.dart';
import '../../../core/storage/secure_storage.dart';
import '../../../core/telemetry/ws_telemetry.dart';
import '../../../core/zkp/prover_service.dart';

// ─── Events ───────────────────────────────────────────────────────────────────

abstract class AuthEvent extends Equatable {
  const AuthEvent();
  @override List<Object?> get props => [];
}

class AuthInitialised extends AuthEvent {
  const AuthInitialised();
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

class AuthRegisterDevice extends AuthEvent {
  const AuthRegisterDevice();
}

// ─── States ───────────────────────────────────────────────────────────────────

abstract class AuthState extends Equatable {
  const AuthState();
  @override List<Object?> get props => [];
}

class AuthInitial          extends AuthState { const AuthInitial(); }
class AuthCheckingStorage  extends AuthState { const AuthCheckingStorage(); }
class AuthNoSecret         extends AuthState { const AuthNoSecret(); }
class AuthIdle             extends AuthState { const AuthIdle(); }
class AuthChallenging      extends AuthState { const AuthChallenging(); }
class AuthProving          extends AuthState { const AuthProving(); }
class AuthSubmitting       extends AuthState { const AuthSubmitting(); }
class AuthAuthenticated    extends AuthState {
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
  final AuthApi           _authApi;
  final SecureStorage     _storage;
  final WsTelemetryService _wsTelemetry;
  final ProverService     _prover = ProverService();

  AuthBloc({
    required AuthApi authApi,
    required SecureStorage storage,
    required WsTelemetryService wsTelemetry,
  })  : _authApi      = authApi,
        _storage      = storage,
        _wsTelemetry  = wsTelemetry,
        super(const AuthInitial()) {
    on<AuthInitialised>(_onInitialised);
    on<AuthLoginRequested>(_onLoginRequested);
    on<AuthRegisterDevice>(_onRegisterDevice);
    on<AuthStepUpRequired>(_onStepUpRequired);
    on<AuthStepUpResolveRequested>(_onStepUpResolve);
    on<AuthLogoutRequested>(_onLogout);
  }

  // ─── Initialise ────────────────────────────────────────────────────────────

  Future<void> _onInitialised(
    AuthInitialised event,
    Emitter<AuthState> emit,
  ) async {
    emit(const AuthCheckingStorage());
    final hasSecret = await _storage.hasSecret();
    if (!hasSecret) {
      emit(const AuthNoSecret());
    } else {
      emit(const AuthIdle());
    }
  }

  // ─── Login ─────────────────────────────────────────────────────────────────

  Future<void> _onLoginRequested(
    AuthLoginRequested event,
    Emitter<AuthState> emit,
  ) async {
    final secretHex = await _storage.getSecret();
    if (secretHex == null) { emit(const AuthNoSecret()); return; }

    try {
      emit(const AuthChallenging());
      final challenge = await _authApi.fetchChallenge();

      emit(const AuthProving());
      final result = await _prover.prove(
        nonceHex:  challenge.nonce,
        secretHex: secretHex,
      );

      emit(const AuthSubmitting());
      final tokens = await _authApi.submitProof(
        challengeId:   challenge.challengeId,
        proof:         result.proof,
        publicSignals: result.publicSignals,
      );

      await Future.wait([
        _storage.saveAccessToken(tokens.accessToken),
        _storage.saveRefreshToken(tokens.refreshToken),
        _storage.saveSessionId(tokens.sessionId),
      ]);

      // Open WebSocket telemetry stream
      _wsTelemetry.connect(
        accessToken: tokens.accessToken,
        sessionId:   tokens.sessionId,
      );

      emit(AuthAuthenticated(sessionId: tokens.sessionId));
    } catch (e) {
      emit(AuthError(message: e.toString()));
    }
  }

  // ─── Step-up trigger ───────────────────────────────────────────────────────

  Future<void> _onStepUpRequired(
    AuthStepUpRequired event,
    Emitter<AuthState> emit,
  ) async {
    emit(AuthStepUpPending(level: event.level, expiresAt: event.expiresAt));
  }

  // ─── Step-up resolve ───────────────────────────────────────────────────────

  Future<void> _onStepUpResolve(
    AuthStepUpResolveRequested event,
    Emitter<AuthState> emit,
  ) async {
    final secretHex = await _storage.getSecret();
    if (secretHex == null) { emit(const AuthNoSecret()); return; }

    try {
      emit(const AuthStepUpProving());

      final challenge = await _authApi.fetchStepUpChallenge();
      final result    = await _prover.prove(
        nonceHex:  challenge.nonce,
        secretHex: secretHex,
      );

      await _authApi.submitStepUpProof(
        challengeId:   challenge.challengeId,
        proof:         result.proof,
        publicSignals: result.publicSignals,
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

  // ─── Register Device ───────────────────────────────────────────────────────

  Future<void> _onRegisterDevice(
    AuthRegisterDevice event,
    Emitter<AuthState> emit,
  ) async {
    try {
      emit(const AuthCheckingStorage());
      // Generate a new secret (random 32 bytes as hex)
      final secret = _prover.generateSecret();
      // Save to secure storage
      await _storage.saveSecret(secret);
      // Transition to idle state so user can now login
      emit(const AuthIdle());
    } catch (e) {
      emit(AuthError(message: 'Failed to register device: ${e.toString()}'));
    }
  }
}
