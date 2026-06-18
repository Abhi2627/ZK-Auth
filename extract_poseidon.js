// One-off extraction script: pulls the EXACT Poseidon constants and
// reference test vectors from circomlibjs (already in node_modules) and
// emits ready-to-paste Dart code for t=2 and t=3.
//
// Run from repo root:
//   node extract_poseidon.js > poseidon_dart_output.txt
//
// This exists purely to avoid hand-transcribing ~195 large field-element
// constants, which is exactly the kind of error a single wrong digit makes
// silently fatal (hash mismatch with no exception). The computer copies the
// numbers; nobody re-types them.

const { unstringifyBigInts } = require('ffjavascript').utils;
const poseidon = require('circomlibjs/src/poseidon.js');
const opt = unstringifyBigInts(require('circomlibjs/src/poseidon_constants_opt.json'));

function bigIntArrayToDart(varName, arr) {
  const items = arr.map((x) => `'${x.toString()}'`).join(',\n  ');
  return `final List<BigInt> ${varName} = <String>[\n  ${items},\n].map((s) => BigInt.parse(s)).toList();`;
}

function bigIntMatrixToDart(varName, mat) {
  const rows = mat
    .map((row) => `  [\n    ${row.map((x) => `'${x.toString()}'`).join(',\n    ')},\n  ]`)
    .join(',\n');
  return `final List<List<BigInt>> ${varName} = [\n${rows},\n].map((row) => row.map((s) => BigInt.parse(s)).toList()).toList();`;
}

console.log('// ============================================================');
console.log('// AUTO-GENERATED from node_modules/circomlibjs - DO NOT HAND EDIT');
console.log('// Source: poseidon_constants_opt.json, t-2 index = [0]=t2, [1]=t3');
console.log('// ============================================================\n');

for (const t of [2, 3]) {
  const idx = t - 2;
  console.log(`// ---- t=${t} ----`);
  console.log(bigIntArrayToDart(`_C${t}`, opt.C[idx]));
  console.log('');
  console.log(bigIntMatrixToDart(`_M${t}`, opt.M[idx]));
  console.log('');
  console.log(bigIntMatrixToDart(`_P${t}`, opt.P[idx]));
  console.log('');
  console.log(bigIntArrayToDart(`_S${t}`, opt.S[idx]));
  console.log('');
  console.log(`// lengths for t=${t}: C=${opt.C[idx].length} M=${opt.M[idx].length}x${opt.M[idx][0].length} P=${opt.P[idx].length}x${opt.P[idx][0].length} S=${opt.S[idx].length}`);
  console.log('');
}

console.log('// ============================================================');
console.log('// TEST VECTORS (for cross-checking the Dart port)');
console.log('// ============================================================\n');

const vec1 = poseidon(['1']);
const vec2a = poseidon(['1', '2']);
const vec2b = poseidon(['12345', '67890']);
const vecSecretLike = poseidon(['123456789012345678901234567890']);

console.log(`// poseidon(["1"])              = ${vec1.toString()}`);
console.log(`// poseidon(["1","2"])          = ${vec2a.toString()}`);
console.log(`// poseidon(["12345","67890"])  = ${vec2b.toString()}`);
console.log(`// poseidon(["123456789012345678901234567890"]) = ${vecSecretLike.toString()}`);
