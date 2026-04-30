'use client';

import { useEffect } from 'react';
import { useRouter }  from 'next/navigation';

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    // Check for stored access token
    const token =
      typeof window !== 'undefined'
        ? localStorage.getItem('zk_auth_access_token')
        : null;

    // Route groups (auth), (dashboard) strip parentheses from URL
    // src/app/(auth)/login   → /login
    // src/app/(dashboard)    → /dashboard
    router.replace(token ? '/dashboard' : '/login');
  }, [router]);

  return null;
}
