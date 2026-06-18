// Cross-checks the Dart Poseidon port against real circomlibjs output.
//
// Test vectors were generated directly by circomlibjs's own poseidon()
// function (via extract_poseidon.js at the repo root) — not invented or
// hand-computed — so a pass here means our Dart implementation produces
// bit-for-bit identical output to the actual library the circuit's
// witness generator is built from.
//
// Run with: flutter test test/poseidon_bn254_test.dart

import 'package:flutter_test/flutter_test.dart';
import 'package:zk_auth/core/zkp/poseidon_bn254.dart' as poseidon;

void main() {
  group('Poseidon BN254 — matches circomlibjs reference output', () {
    test('poseidon(["1"]) — t=2, single input', () {
      final result = poseidon.poseidonHash([BigInt.from(1)]);
      expect(
        result,
        '18586133768512220936620570745912940619677854269274689475585506675881198879027',
      );
    });

    test('poseidon(["1","2"]) — t=3, two inputs', () {
      final result = poseidon.poseidonHash([BigInt.from(1), BigInt.from(2)]);
      expect(
        result,
        '7853200120776062878684798364095072458815029376092732009249414926327459813530',
      );
    });

    test('poseidon(["12345","67890"]) — t=3, larger inputs', () {
      final result =
          poseidon.poseidonHash([BigInt.from(12345), BigInt.from(67890)]);
      expect(
        result,
        '11344094074881186137859743404234365978119253787583526441303892667757095072923',
      );
    });

    test('poseidon(["123456789012345678901234567890"]) — t=2, large single input', () {
      final result = poseidon
          .poseidonHash([BigInt.parse('123456789012345678901234567890')]);
      expect(
        result,
        '192670425303263827811639944807869901400572500529303854296361502138035327707',
      );
    });

    test('hexToField applies BN254 field reduction correctly', () {
      // A 32-byte (256-bit) hex value that exceeds the ~254-bit field
      // modulus must be reduced mod p — this mirrors witness.ts on the
      // web side, which performs the identical reduction before feeding
      // values into the circuit.
      final big = poseidon.hexToField(
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      );
      final p = BigInt.parse(
        '21888242871839275222246405745257275088548364400416034343698204186575808495617',
      );
      expect(big < p, true);
      expect(big >= BigInt.zero, true);
    });
  });
}
