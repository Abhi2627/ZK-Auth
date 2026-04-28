import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // ─── WASM support (required by snarkjs) ────────────────────────────────────
  webpack: (config) => {
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
    // Allow snarkjs to import .wasm files from node_modules
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs:   false,
      path: false,
    };
    return config;
  },

  // ─── Standalone output for Docker production stage ──────────────────────────
  // Creates .next/standalone which includes only the files needed to run the
  // server — no node_modules bloat in the production image.
  output: 'standalone',

  // ─── Allow the backend container hostname in API calls ─────────────────────
  // Server-side fetch calls to the backend use the Docker service name.
  // NEXT_PUBLIC_API_URL uses the service name when built inside Docker.
  experimental: {
    // Server Actions can call the backend via internal Docker network
    serverActions: {
      allowedOrigins: ['backend:3001', 'localhost:3001'],
    },
  },
};

export default nextConfig;
