# ZKP circuit artifacts go here after compilation.
# Do NOT commit .zkey files — they are large and circuit-specific.
# verification_key.json IS committed (needed by the gateway at runtime).
#
# Compile steps (Phase 3):
#   circom auth.circom --r1cs --wasm --sym -o auth/
#   snarkjs groth16 setup auth/auth.r1cs pot_final.ptau auth/auth_0000.zkey
#   snarkjs zkey contribute auth/auth_0000.zkey auth/auth_final.zkey --name="contributor"
#   snarkjs zkey export verificationkey auth/auth_final.zkey auth/verification_key.json
