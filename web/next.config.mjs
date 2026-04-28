/** @type {import('next').NextConfig} */
const nextConfig = {
  // ─── WASM support for snarkjs ─────────────────────────────────────────────
  webpack: (config, { isServer }) => {
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };

    if (isServer) {
      const externals = Array.isArray(config.externals) ? config.externals : [];
      config.externals = [...externals, 'snarkjs'];
    }

    config.resolve = {
      ...config.resolve,
      fallback: {
        ...config.resolve?.fallback,
        fs:   false,
        path: false,
        os:   false,
      },
    };

    return config;
  },

  output: 'standalone',
};

export default nextConfig;
