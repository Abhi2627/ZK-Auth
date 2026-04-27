/// Auth API — typed methods for all authentication endpoints.

import 'package:dio/dio.dart';
import 'http_client.dart';

// ─── Response models ──────────────────────────────────────────────────────────

class ChallengeResponse {
  final String challengeId;
  final String nonce;
  final int expiresAt;

  const ChallengeResponse({
    required this.challengeId,
    required this.nonce,
    required this.expiresAt,
  });

  factory ChallengeResponse.fromJson(Map<String, dynamic> json) =>
      ChallengeResponse(
        challengeId: json['challenge_id'] as String,
        nonce:       json['nonce']        as String,
        expiresAt:   json['expires_at']   as int,
      );
}

class AuthTokens {
  final String accessToken;
  final String refreshToken;
  final String sessionId;
  final int    expiresIn;

  const AuthTokens({
    required this.accessToken,
    required this.refreshToken,
    required this.sessionId,
    required this.expiresIn,
  });

  factory AuthTokens.fromJson(Map<String, dynamic> json) => AuthTokens(
        accessToken:  json['access_token']  as String,
        refreshToken: json['refresh_token'] as String,
        sessionId:    json['session_id']    as String,
        expiresIn:    json['expires_in']    as int,
      );
}

// ─── API ──────────────────────────────────────────────────────────────────────

class AuthApi {
  final ZkAuthHttpClient _client;

  const AuthApi({required ZkAuthHttpClient client}) : _client = client;

  Future<ChallengeResponse> fetchChallenge({String? commitmentHash}) async {
    final response = await _client.dio.post<Map<String, dynamic>>(
      '/auth/challenge',
      data: commitmentHash != null
          ? {'commitment_hash': commitmentHash}
          : <String, dynamic>{},
    );
    return ChallengeResponse.fromJson(response.data!);
  }

  Future<AuthTokens> submitProof({
    required String challengeId,
    required Map<String, dynamic> proof,
    required List<String> publicSignals,
  }) async {
    final response = await _client.dio.post<Map<String, dynamic>>(
      '/auth/verify',
      data: {
        'challenge_id':   challengeId,
        'proof':          proof,
        'public_signals': publicSignals,
      },
    );
    return AuthTokens.fromJson(response.data!);
  }

  Future<AuthTokens> refreshTokens(String refreshToken) async {
    final response = await _client.dio.post<Map<String, dynamic>>(
      '/auth/refresh',
      data: {'refresh_token': refreshToken},
    );
    return AuthTokens.fromJson(response.data!);
  }

  Future<void> logout({bool allDevices = false}) async {
    await _client.dio.post<void>(
      '/auth/logout',
      data: {'all_devices': allDevices},
    );
  }

  Future<ChallengeResponse> fetchStepUpChallenge() async {
    final response = await _client.dio.post<Map<String, dynamic>>(
      '/session/step-up/challenge',
      data: <String, dynamic>{},
    );
    return ChallengeResponse.fromJson(response.data!);
  }

  Future<bool> submitStepUpProof({
    required String challengeId,
    required Map<String, dynamic> proof,
    required List<String> publicSignals,
  }) async {
    final response = await _client.dio.post<Map<String, dynamic>>(
      '/session/step-up/resolve',
      data: {
        'challenge_id':   challengeId,
        'proof':          proof,
        'public_signals': publicSignals,
      },
    );
    return response.data?['resolved'] as bool? ?? false;
  }
}
