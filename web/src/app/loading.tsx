'use client';

import { motion } from 'framer-motion';

export default function Loading() {
  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: '#010409',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: 20, zIndex: 9999,
    }}>
      {/* Animated logo */}
      <motion.div
        style={{
          width: 72, height: 72,
          background: 'linear-gradient(135deg, #1f6feb, #388bfd)',
          borderRadius: 18,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 30, fontWeight: 900, color: '#fff',
          fontFamily: 'system-ui, sans-serif',
          boxShadow: '0 0 40px #1f6feb55',
        }}
        animate={{ scale: [1, 1.08, 1], opacity: [0.9, 1, 0.9] }}
        transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
      >
        ZK
      </motion.div>

      <div style={{ textAlign: 'center' }}>
        <p style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#e6edf3', fontFamily: 'system-ui, sans-serif' }}>
          ZK-Auth
        </p>
        <p style={{ margin: '4px 0 0', fontSize: 12, color: '#8b949e', fontFamily: 'system-ui, sans-serif' }}>
          Zero-Knowledge Authentication
        </p>
      </div>

      {/* Progress dots */}
      <div style={{ display: 'flex', gap: 6 }}>
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            style={{ width: 7, height: 7, borderRadius: '50%', background: '#388bfd' }}
            animate={{ opacity: [0.2, 1, 0.2] }}
            transition={{ repeat: Infinity, duration: 1.2, delay: i * 0.3 }}
          />
        ))}
      </div>
    </div>
  );
}
