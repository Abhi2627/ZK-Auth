import { redirect } from 'next/navigation';

// Root page — immediately redirect to /login
// This is a server component so redirect() works synchronously
export default function HomePage() {
  redirect('/login');
}
