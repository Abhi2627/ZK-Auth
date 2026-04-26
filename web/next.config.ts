import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // snarkjs requires this for WASM support
  webpack: (config) => {
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
    return config;
  },
};

export default nextConfig;
