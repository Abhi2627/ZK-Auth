'use client';

import { useRouter } from 'next/navigation';
import { LoginForm } from '../../../components/AuthFlow/LoginForm';

export default function LoginPage() {
  const router = useRouter();

  return (
    <main style={{
      display:         'flex',
      minHeight:       '100vh',
      alignItems:      'center',
      justifyContent:  'center',
      background:      '#010409',
      padding:         '24px',
    }}>
      <LoginForm
        onSuccess={() => {
          router.push('/dashboard');
        }}
      />
    </main>
  );
}
