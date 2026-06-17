import { redirect } from 'next/navigation';

// Root page — redirect to platform landing page
// Users land on the product page first; authenticated users reach /login from nav
export default function HomePage() {
  redirect('/platform');
}
