'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getAccessToken } from '../lib/api';

/**
 * Root page — redirects unauthenticated users to login
 */
export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    const token = getAccessToken();
    if (!token) {
      router.replace('/(auth)/login');
    } else {
      router.replace('/(dashboard)');
    }
  }, [router]);

  return null;
}
