'use client';

import { LoginForm } from '../../../components/AuthFlow/LoginForm';
import { useRouter }  from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();

  return (
    <main style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center' }}>
      <LoginForm
        onSuccess={(sessionId) => {
          // Phase 7: start telemetry collector here with sessionId
          router.push('/dashboard');
        }}
      />
    </main>
  );
}
