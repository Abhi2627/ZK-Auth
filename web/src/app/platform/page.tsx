'use client';

/**
 * ZK-Auth Platform — Landing Page
 *
 * Production SaaS landing page for institute onboarding.
 * Sections: Nav → Hero → Problem/Solution → How It Works →
 *           Features → Use Cases → Pricing → Register CTA → Footer
 *
 * Design: dark-first, green/blue accent, professional SaaS aesthetic.
 * Responsive: desktop-first with mobile breakpoints via inline media queries.
 */

import React, { useState, useEffect, useRef } from 'react';

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RegisterForm {
  institute_name: string;
  institute_type: string;
  email:          string;
  website:        string;
  credential_types: string[];
  contact_name:   string;
}

type PricingTier = 'free' | 'starter' | 'professional' | 'enterprise';

// ─── Constants ────────────────────────────────────────────────────────────────

const CREDENTIAL_TYPES = [
  { id: 'AcademicDegree',         label: 'Academic Degree',          icon: '🎓' },
  { id: 'Transcript',             label: 'Academic Transcript',      icon: '📄' },
  { id: 'ResearchCertificate',    label: 'Research Certificate',     icon: '🔬' },
  { id: 'BankStatement',          label: 'Bank Statement',           icon: '🏦' },
  { id: 'LoanClearance',          label: 'Loan Clearance',           icon: '✅' },
  { id: 'KYCRecord',              label: 'KYC Verification',         icon: '🪪' },
  { id: 'MedicalRecord',          label: 'Medical Record',           icon: '🏥' },
  { id: 'VaccineCertificate',     label: 'Vaccination Certificate',  icon: '💉' },
  { id: 'EmploymentRecord',       label: 'Employment Record',        icon: '💼' },
  { id: 'GovernmentID',           label: 'Government ID',            icon: '🏛️' },
  { id: 'ProfessionalLicense',    label: 'Professional License',     icon: '📋' },
  { id: 'PropertyDocument',       label: 'Property Document',        icon: '🏠' },
];

const INSTITUTE_TYPES = [
  'University / College',
  'School / Board',
  'Bank / NBFC',
  'Hospital / Healthcare',
  'Government Agency',
  'Corporate HR',
  'Professional Body',
  'Insurance Company',
  'Other',
];

const FEATURES = [
  {
    icon: '🔐',
    title: 'Zero-Knowledge Authentication',
    desc: 'Users prove identity with Groth16 ZK-SNARK proofs. No passwords. No shared secrets. The server never sees your users\' private data.',
    tag: 'Core Protocol',
  },
  {
    icon: '🌳',
    title: 'Selective Disclosure',
    desc: 'Poseidon Merkle trees let holders prove individual attributes without revealing others. Prove age ≥ 18 without exposing date of birth.',
    tag: 'Privacy',
  },
  {
    icon: '🧠',
    title: 'Continuous Identity Verification',
    desc: 'LSTM behavioral biometrics monitor sessions in real-time. Anomaly detection triggers re-authentication before damage is done.',
    tag: 'Security',
  },
  {
    icon: '🌐',
    title: 'W3C DID Ecosystem',
    desc: 'Every institute gets a Decentralized Identifier (DID). Credentials are signed with Ed25519. Verification works without calling ZK-Auth servers.',
    tag: 'Standards',
  },
  {
    icon: '🔑',
    title: 'Per-Institute Signing Keys',
    desc: 'Each institute generates a unique Ed25519 keypair. Only you hold your private key. ZK-Auth never stores it after onboarding.',
    tag: 'Sovereignty',
  },
  {
    icon: '⚡',
    title: 'Universal Verification',
    desc: 'Any verifier — bank, employer, government — can verify credentials from any ZK-Auth institute without contacting the issuing institute.',
    tag: 'Interoperability',
  },
];

const USE_CASES = [
  { icon: '🎓', sector: 'Education', orgs: 'MANIT, IITs, NITs, Universities', creds: 'Degrees, Transcripts, Research Certs', color: '#1f6feb' },
  { icon: '🏦', sector: 'Banking',   orgs: 'SBI, HDFC, Kotak, ICICI',        creds: 'Statements, KYC, Loan Clearance',    color: '#2ea043' },
  { icon: '🏥', sector: 'Healthcare',orgs: 'Apollo, AIIMS, Fortis',           creds: 'Medical Records, Vaccine Certs',     color: '#a371f7' },
  { icon: '🏛️', sector: 'Government',orgs: 'DigiLocker, MCA, CBSE, UIDAI',   creds: 'National ID, Licenses, Permits',     color: '#f0883e' },
  { icon: '💼', sector: 'Corporate', orgs: 'Infosys, TCS, Wipro, Startups',   creds: 'Employment Records, Salary Certs',   color: '#ec6547' },
  { icon: '📋', sector: 'Licensing', orgs: 'Bar Council, ICAI, BCI, MCI',     creds: 'Professional Licenses, Memberships', color: '#58a6ff' },
];

const PRICING: Array<{
  tier: PricingTier;
  name: string;
  price: string;
  period: string;
  tagline: string;
  highlight: boolean;
  badge?: string;
  features: string[];
  cta: string;
}> = [
  {
    tier: 'free',
    name: 'Free',
    price: '₹0',
    period: '/month',
    tagline: 'For pilots and evaluation',
    highlight: false,
    features: [
      '1 credential type',
      '500 credentials / month',
      '1 institute DID',
      'ZKP authentication',
      'Community support',
      'Shared infrastructure',
    ],
    cta: 'Start Free',
  },
  {
    tier: 'starter',
    name: 'Starter',
    price: '₹4,999',
    period: '/month',
    tagline: 'For small institutes',
    highlight: false,
    features: [
      '5 credential types',
      '10,000 credentials / month',
      'Custom institute DID',
      'ZKP + LSTM behavioral auth',
      'Selective disclosure',
      'Email support',
      'Analytics dashboard',
    ],
    cta: 'Get Started',
  },
  {
    tier: 'professional',
    name: 'Professional',
    price: '₹19,999',
    period: '/month',
    tagline: 'For growing institutions',
    highlight: true,
    badge: 'Most Popular',
    features: [
      'Unlimited credential types',
      '1,00,000 credentials / month',
      'Custom DID + branded portal',
      'Full ZKP + LSTM + Biometrics',
      'W3C VC interoperability',
      'Priority support + SLA',
      'Advanced analytics',
      'API + SDK access',
      'White-label option',
    ],
    cta: 'Start Professional',
  },
  {
    tier: 'enterprise',
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    tagline: 'For large organizations',
    highlight: false,
    features: [
      'Unlimited everything',
      'On-premise deployment',
      'Custom circuit compilation',
      'Dedicated infrastructure',
      'Compliance (ISO 27001, DPDP)',
      '24/7 dedicated support',
      'Custom integrations',
      'NDA + MSA',
      'Training & onboarding',
    ],
    cta: 'Contact Sales',
  },
];

// ─── Counter animation hook ───────────────────────────────────────────────────

function useCountUp(target: number, duration = 1500, start = false) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!start) return;
    let startTime: number | null = null;
    const step = (timestamp: number) => {
      if (!startTime) startTime = timestamp;
      const progress = Math.min((timestamp - startTime) / duration, 1);
      setValue(Math.floor(progress * target));
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [target, duration, start]);
  return value;
}

// ─── Stat card component ──────────────────────────────────────────────────────

function StatCard({ value, suffix, label, started }: {
  value: number; suffix: string; label: string; started: boolean;
}) {
  const count = useCountUp(value, 1200, started);
  return (
    <div style={s.statCard}>
      <p style={s.statNum}>{count.toLocaleString()}{suffix}</p>
      <p style={s.statLabel}>{label}</p>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function PlatformPage() {
  const [registerForm, setRegisterForm] = useState<RegisterForm>({
    institute_name: '', institute_type: '', email: '',
    website: '', credential_types: [], contact_name: '',
  });
  const [submitState, setSubmitState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [selectedPricing, setSelectedPricing] = useState<PricingTier>('professional');
  const [statsVisible, setStatsVisible] = useState(false);
  const statsRef = useRef<HTMLDivElement>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  // Scroll effects
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Stats intersection observer
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setStatsVisible(true); },
      { threshold: 0.3 },
    );
    if (statsRef.current) observer.observe(statsRef.current);
    return () => observer.disconnect();
  }, []);

  const toggleCredType = (id: string) => {
    setRegisterForm(prev => ({
      ...prev,
      credential_types: prev.credential_types.includes(id)
        ? prev.credential_types.filter(c => c !== id)
        : [...prev.credential_types, id],
    }));
  };

  const handleRegister = async () => {
    const { institute_name, institute_type, email, contact_name, credential_types } = registerForm;
    if (!institute_name || !institute_type || !email || !contact_name || !credential_types.length) {
      setErrorMsg('Please fill all required fields and select at least one credential type.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setErrorMsg('Please enter a valid email address.');
      return;
    }
    setSubmitState('loading');
    setErrorMsg('');
    try {
      const r = await fetch(`${API}/api/platform/register-institute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...registerForm, plan: selectedPricing }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({})) as { message?: string };
        throw new Error(d.message ?? 'Registration failed');
      }
      setSubmitState('success');
      // Store institute identity so the issuer portal can read it
      const regData = {
        name: registerForm.institute_name,
        type: registerForm.institute_type,
        did:  `did:web:${registerForm.institute_name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 40)}.zk-auth.io`,
      };
      sessionStorage.setItem('institute_registration', JSON.stringify(regData));
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
      setSubmitState('error');
    }
  };

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
    setMobileMenuOpen(false);
  };

  return (
    <div style={s.root}>

      {/* ══════════════════════════════════════════════════════════════
          NAV
      ══════════════════════════════════════════════════════════════ */}
      <nav style={{ ...s.nav, ...(scrolled ? s.navScrolled : {}) }}>
        <div style={s.navInner}>
          {/* Logo */}
          <div style={s.navLogo} onClick={() => scrollTo('hero')}>
            <div style={s.navLogoMark}>
              <span style={{ fontSize: 18, fontWeight: 900, letterSpacing: -1 }}>ZK</span>
            </div>
            <span style={s.navLogoText}>ZK-Auth</span>
            <span style={s.navLogoBadge}>Platform</span>
          </div>

          {/* Desktop links */}
          <div style={s.navLinks}>
            {[
              ['Features',   'features'],
              ['How It Works','howitworks'],
              ['Use Cases',  'usecases'],
              ['Pricing',    'pricing'],
              ['Docs',       'footer'],
            ].map(([label, id]) => (
              <button key={id} style={s.navLink} onClick={() => scrollTo(id)}>
                {label}
              </button>
            ))}
          </div>

          {/* CTAs */}
          <div style={s.navCtas}>
            <a href="/login" style={s.navSignIn}>Sign In</a>
            <button style={s.navGetStarted} onClick={() => scrollTo('register')}>
              Get Started Free →
            </button>
          </div>
        </div>
      </nav>

      {/* ══════════════════════════════════════════════════════════════
          HERO
      ══════════════════════════════════════════════════════════════ */}
      <section id="hero" style={s.hero}>
        {/* Background grid */}
        <div style={s.heroGrid} aria-hidden="true" />
        <div style={s.heroGlow} aria-hidden="true" />

        <div style={s.heroContent}>
          {/* Announcement badge */}
          <div style={s.heroBadge}>
            <span style={s.heroBadgeDot} />
            <span>Research-backed · FrontSci 2025 · Springer Nature</span>
          </div>

          {/* Headline */}
          <h1 style={s.heroTitle}>
            Issue credentials your users<br />
            can prove <span style={s.heroTitleAccent}>without revealing anything</span>
          </h1>

          <p style={s.heroSub}>
            ZK-Auth is a zero-knowledge credential infrastructure platform.
            Institutions issue tamper-proof digital credentials with their own cryptographic identity.
            Users prove claims anywhere — without sharing their data.
          </p>

          {/* CTAs */}
          <div style={s.heroCtas}>
            <button style={s.heroCtaPrimary} onClick={() => scrollTo('register')}>
              Register Your Institute Free
            </button>
            <a href="/login" style={s.heroCtaSecondary}>
              View Live Demo →
            </a>
          </div>

          {/* Trust bar */}
          <div style={s.trustBar}>
            {[
              '🔐 Groth16 ZK-SNARKs',
              '🌐 W3C DID / VC Standard',
              '🧠 LSTM Behavioral Auth',
              '🔑 Per-Institute Keys',
            ].map(item => (
              <span key={item} style={s.trustItem}>{item}</span>
            ))}
          </div>
        </div>

        {/* Hero visual — architecture diagram */}
        <div style={s.heroVisual}>
          <div style={s.archCard}>
            <p style={s.archTitle}>Trust Architecture</p>
            {[
              { role: 'ZK-Auth Platform', sub: 'Root of Trust · Issues institute DIDs', color: '#f0883e', icon: '🏛️' },
              { role: 'MANIT / SBI / Apollo', sub: 'Authorised Issuers · Own private keys', color: '#388bfd', icon: '🏦' },
              { role: 'Student / Customer', sub: 'ZK Wallet · Controls their data', color: '#4ade80', icon: '👤' },
              { role: 'Employer / Govt / Bank', sub: 'Verifier · Gets boolean proofs only', color: '#a371f7', icon: '✅' },
            ].map((item, i) => (
              <div key={item.role}>
                <div style={{ ...s.archRow, borderColor: item.color + '44' }}>
                  <span style={s.archIcon}>{item.icon}</span>
                  <div>
                    <p style={{ ...s.archRole, color: item.color }}>{item.role}</p>
                    <p style={s.archSub}>{item.sub}</p>
                  </div>
                </div>
                {i < 3 && (
                  <div style={s.archArrow}>↓ <span style={{ color: '#484f58', fontSize: 11 }}>
                    {['authorises →', 'issues credentials to →', 'proves claims to →'][i]}
                  </span></div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          STATS
      ══════════════════════════════════════════════════════════════ */}
      <div ref={statsRef} style={s.statsSection}>
        <StatCard value={120641}  suffix="+"  label="LSTM model parameters"   started={statsVisible} />
        <StatCard value={8}       suffix=""   label="Merkle tree depth (256 attrs)" started={statsVisible} />
        <StatCard value={50}      suffix="ms" label="Avg verification latency"  started={statsVisible} />
        <StatCard value={0}       suffix=""   label="Raw PII ever stored"        started={statsVisible} />
      </div>

      {/* ══════════════════════════════════════════════════════════════
          PROBLEM / SOLUTION
      ══════════════════════════════════════════════════════════════ */}
      <section style={s.section}>
        <div style={s.sectionHeader}>
          <span style={s.sectionBadge}>The Problem</span>
          <h2 style={s.sectionTitle}>Digital credentials are broken</h2>
          <p style={s.sectionSub}>
            Today's credential systems force users to share everything to prove anything.
            ZK-Auth changes the equation.
          </p>
        </div>

        <div style={s.compareGrid}>
          {/* Old way */}
          <div style={{ ...s.compareCard, borderColor: '#6e1f1f' }}>
            <div style={{ ...s.compareHeader, background: '#1a0505' }}>
              <span style={{ fontSize: 24 }}>❌</span>
              <p style={{ ...s.compareTitle, color: '#f87171' }}>The Old Way</p>
            </div>
            {[
              'Physical documents that can be forged',
              'Share entire transcript to prove one grade',
              'Centralized DB — one breach exposes all',
              'User has no control over their data',
              'Verification requires calling the issuer',
              'No cryptographic proof of authenticity',
              'Password auth vulnerable to credential stuffing',
            ].map(item => (
              <div key={item} style={s.compareItem}>
                <span style={{ color: '#f87171', flexShrink: 0 }}>✗</span>
                <span style={{ fontSize: 13, color: '#8b949e' }}>{item}</span>
              </div>
            ))}
          </div>

          {/* ZK-Auth way */}
          <div style={{ ...s.compareCard, borderColor: '#238636' }}>
            <div style={{ ...s.compareHeader, background: '#0a1d0f' }}>
              <span style={{ fontSize: 24 }}>✅</span>
              <p style={{ ...s.compareTitle, color: '#4ade80' }}>ZK-Auth Way</p>
            </div>
            {[
              'Cryptographically signed — mathematically unforgeable',
              'Prove one claim without revealing any others',
              'Zero raw PII stored — only Poseidon commitments',
              'User controls what they share, to whom, when',
              'Offline verification via DID document resolution',
              'Groth16 ZK-SNARK proof — cryptographic guarantee',
              'Secret-based ZKP — no password ever transmitted',
            ].map(item => (
              <div key={item} style={s.compareItem}>
                <span style={{ color: '#4ade80', flexShrink: 0 }}>✓</span>
                <span style={{ fontSize: 13, color: '#c9d1d9' }}>{item}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          HOW IT WORKS
      ══════════════════════════════════════════════════════════════ */}
      <section id="howitworks" style={{ ...s.section, background: '#080c10' }}>
        <div style={s.sectionHeader}>
          <span style={s.sectionBadge}>How It Works</span>
          <h2 style={s.sectionTitle}>Like RBI authorising banks to issue their own instruments</h2>
          <p style={s.sectionSub}>
            ZK-Auth is the root authority. Each institute gets unique cryptographic keys.
            No two institutes can issue each other's credentials.
          </p>
        </div>

        <div style={s.stepsGrid}>
          {/* For Institutes */}
          <div style={s.stepsCol}>
            <p style={s.stepsColTitle}>🏛️ For Institutes</p>
            {[
              { n: '01', title: 'Register & Subscribe', desc: 'Institute registers on ZK-Auth platform, selects credential types, chooses plan.' },
              { n: '02', title: 'Receive Your Keys', desc: 'ZK-Auth generates a unique Ed25519 keypair + DID. Private key delivered once — never stored by platform.' },
              { n: '03', title: 'Issue Credentials', desc: 'Use the ZK-Auth API to issue credentials to your users. Each credential carries your institute\'s cryptographic signature.' },
            ].map(step => (
              <div key={step.n} style={s.step}>
                <div style={s.stepNum}>{step.n}</div>
                <div>
                  <p style={s.stepTitle}>{step.title}</p>
                  <p style={s.stepDesc}>{step.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Divider */}
          <div style={s.stepsDivider}>
            <div style={s.stepsDividerLine} />
            <div style={s.stepsDividerBadge}>ZK-Auth<br />Platform</div>
            <div style={s.stepsDividerLine} />
          </div>

          {/* For Users */}
          <div style={s.stepsCol}>
            <p style={s.stepsColTitle}>👤 For Users</p>
            {[
              { n: '01', title: 'Generate ZK Secret', desc: 'User generates a 32-byte secret locally. Sends only Poseidon(secret) as commitment — secret never leaves device.' },
              { n: '02', title: 'Receive & Store Credential', desc: 'Issued credential stored in ZK wallet. Contains Merkle commitments — no raw PII anywhere.' },
              { n: '03', title: 'Prove Claims Anywhere', desc: 'User generates Groth16 proof in browser/mobile. Proves "age ≥ 18" to a bank without revealing date of birth.' },
            ].map(step => (
              <div key={step.n} style={s.step}>
                <div style={{ ...s.stepNum, background: '#1a2d1a', color: '#4ade80', borderColor: '#238636' }}>{step.n}</div>
                <div>
                  <p style={s.stepTitle}>{step.title}</p>
                  <p style={s.stepDesc}>{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* RBI analogy callout */}
        <div style={s.analogyBox}>
          <div style={s.analogyIcon}>🏦</div>
          <div>
            <p style={s.analogyTitle}>The Cheque Book Analogy</p>
            <p style={s.analogyText}>
              RBI doesn't print cheque books — it authorises SBI, HDFC, Kotak to print their own,
              each with their unique identifier. Any bank can verify an SBI cheque.
              No bank can forge an SBI cheque. ZK-Auth works identically:
              MANIT issues MANIT credentials signed with MANIT's key.
              Apollo issues Apollo credentials signed with Apollo's key.
              Any verifier can verify either. Neither can forge the other's credentials.
            </p>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          FEATURES
      ══════════════════════════════════════════════════════════════ */}
      <section id="features" style={s.section}>
        <div style={s.sectionHeader}>
          <span style={s.sectionBadge}>Platform Features</span>
          <h2 style={s.sectionTitle}>Enterprise-grade cryptographic infrastructure</h2>
          <p style={s.sectionSub}>
            Built on peer-reviewed cryptography. Every component is production-hardened.
          </p>
        </div>

        <div style={s.featuresGrid}>
          {FEATURES.map(f => (
            <div key={f.title} style={s.featureCard}>
              <div style={s.featureIconWrap}>
                <span style={s.featureIcon}>{f.icon}</span>
                <span style={s.featureTag}>{f.tag}</span>
              </div>
              <p style={s.featureTitle}>{f.title}</p>
              <p style={s.featureDesc}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          USE CASES
      ══════════════════════════════════════════════════════════════ */}
      <section id="usecases" style={{ ...s.section, background: '#080c10' }}>
        <div style={s.sectionHeader}>
          <span style={s.sectionBadge}>Use Cases</span>
          <h2 style={s.sectionTitle}>Built for every institution that issues credentials</h2>
          <p style={s.sectionSub}>From universities to hospitals to banks — any institution with documents to issue.</p>
        </div>

        <div style={s.useCasesGrid}>
          {USE_CASES.map(uc => (
            <div key={uc.sector} style={{ ...s.useCaseCard, borderColor: uc.color + '33' }}>
              <div style={{ ...s.useCaseHeader, background: uc.color + '11' }}>
                <span style={{ fontSize: 32 }}>{uc.icon}</span>
                <p style={{ ...s.useCaseSector, color: uc.color }}>{uc.sector}</p>
              </div>
              <div style={s.useCaseBody}>
                <p style={s.useCaseLabel}>Typical Organisations</p>
                <p style={s.useCaseOrgs}>{uc.orgs}</p>
                <p style={s.useCaseLabel}>Credential Types</p>
                <p style={s.useCaseCreds}>{uc.creds}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          PRICING
      ══════════════════════════════════════════════════════════════ */}
      <section id="pricing" style={s.section}>
        <div style={s.sectionHeader}>
          <span style={s.sectionBadge}>Pricing</span>
          <h2 style={s.sectionTitle}>Simple, transparent pricing</h2>
          <p style={s.sectionSub}>Start free. Scale as you grow. No hidden fees. Cancel anytime.</p>
        </div>

        <div style={s.pricingGrid}>
          {PRICING.map(plan => (
            <div
              key={plan.tier}
              style={{
                ...s.pricingCard,
                ...(plan.highlight ? s.pricingCardHighlight : {}),
                cursor: 'pointer',
              }}
              onClick={() => { setSelectedPricing(plan.tier); scrollTo('register'); }}
            >
              {plan.badge && <div style={s.pricingBadge}>{plan.badge}</div>}
              <p style={s.pricingName}>{plan.name}</p>
              <div style={s.pricingPriceRow}>
                <span style={{ ...s.pricingPrice, ...(plan.highlight ? { color: '#4ade80' } : {}) }}>
                  {plan.price}
                </span>
                <span style={s.pricingPeriod}>{plan.period}</span>
              </div>
              <p style={s.pricingTagline}>{plan.tagline}</p>
              <div style={s.pricingDivider} />
              {plan.features.map(f => (
                <div key={f} style={s.pricingFeatureRow}>
                  <span style={{ color: plan.highlight ? '#4ade80' : '#388bfd', flexShrink: 0 }}>✓</span>
                  <span style={{ fontSize: 13, color: '#c9d1d9' }}>{f}</span>
                </div>
              ))}
              <button
                style={{
                  ...s.pricingCta,
                  ...(plan.highlight ? s.pricingCtaHighlight : {}),
                  marginTop: 'auto',
                  paddingTop: 12,
                }}
              >
                {plan.cta} {plan.tier !== 'enterprise' ? '→' : ''}
              </button>
            </div>
          ))}
        </div>

        <p style={s.pricingNote}>
          All plans include: Ed25519 signing keys · W3C DID document · ZKP verification ·
          GDPR-ready architecture · 99.9% uptime SLA
        </p>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          REGISTER CTA
      ══════════════════════════════════════════════════════════════ */}
      <section id="register" style={{ ...s.section, background: '#080c10' }}>
        <div style={s.registerGrid}>
          {/* Left: copy */}
          <div style={s.registerLeft}>
            <span style={s.sectionBadge}>Get Started</span>
            <h2 style={{ ...s.sectionTitle, textAlign: 'left', marginTop: 12 }}>
              Register your institute
            </h2>
            <p style={{ ...s.sectionSub, textAlign: 'left' }}>
              Takes 2 minutes. Your institute DID and signing keys are generated instantly.
              No payment required to start — upgrade when you need more volume.
            </p>

            <div style={s.registerChecklist}>
              {[
                '✓  Unique Ed25519 keypair generated for your institute',
                '✓  DID document published at did:web:yourname.zk-auth.io',
                '✓  Issuer portal live immediately at zk-auth.io/issue/yourname',
                '✓  API credentials for programmatic credential issuance',
                '✓  Private key delivered once — ZK-Auth never stores it',
              ].map(item => (
                <p key={item} style={s.registerCheckItem}>{item}</p>
              ))}
            </div>

            <div style={s.registerPlanSelected}>
              <span style={{ fontSize: 12, color: '#8b949e' }}>Selected plan:</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#4ade80', marginLeft: 8 }}>
                {PRICING.find(p => p.tier === selectedPricing)?.name}
                {' '}{PRICING.find(p => p.tier === selectedPricing)?.price}
                {PRICING.find(p => p.tier === selectedPricing)?.period}
              </span>
              <button style={s.changePlanBtn} onClick={() => scrollTo('pricing')}>
                Change plan
              </button>
            </div>
          </div>

          {/* Right: form */}
          <div style={s.registerForm}>
            {submitState === 'success' ? (
              <div style={s.successPanel}>
                <div style={s.successIcon}>🎉</div>
                <h3 style={s.successTitle}>Registration Received</h3>
                <p style={s.successText}>
                  We've received your registration for <strong>{registerForm.institute_name}</strong>.
                  Your institute DID and signing keys will be provisioned and sent to{' '}
                  <strong>{registerForm.email}</strong> within minutes.
                </p>
                <div style={s.successChecks}>
                  {[
                    '📧 Confirmation email sent',
                    '🔑 Keypair generation in progress',
                    '🌐 DID document being published',
                    '🚀 Issuer portal provisioning',
                  ].map(item => <p key={item} style={{ margin: '4px 0', fontSize: 13, color: '#4ade80' }}>{item}</p>)}
                </div>
                <p style={{ fontSize: 12, color: '#484f58', marginTop: 16 }}>
                  (Demo mode: credentials are simulated. In production, this triggers real key generation and DID publication.)
                </p>
              </div>
            ) : (
              <>
                <h3 style={s.formTitle}>Institute Registration</h3>

                <div style={s.formGrid}>
                  <div style={s.fieldGroup}>
                    <label style={s.label}>Institute Name *</label>
                    <input
                      style={s.input}
                      placeholder="MANIT Bhopal / SBI / Apollo Hospitals"
                      value={registerForm.institute_name}
                      onChange={e => setRegisterForm(p => ({ ...p, institute_name: e.target.value }))}
                    />
                  </div>

                  <div style={s.fieldGroup}>
                    <label style={s.label}>Contact Person *</label>
                    <input
                      style={s.input}
                      placeholder="Dr. Namita Tiwari"
                      value={registerForm.contact_name}
                      onChange={e => setRegisterForm(p => ({ ...p, contact_name: e.target.value }))}
                    />
                  </div>
                </div>

                <div style={s.formGrid}>
                  <div style={s.fieldGroup}>
                    <label style={s.label}>Institute Type *</label>
                    <select
                      style={s.input}
                      value={registerForm.institute_type}
                      onChange={e => setRegisterForm(p => ({ ...p, institute_type: e.target.value }))}
                    >
                      <option value="">Select type...</option>
                      {INSTITUTE_TYPES.map(t => <option key={t}>{t}</option>)}
                    </select>
                  </div>

                  <div style={s.fieldGroup}>
                    <label style={s.label}>Official Email *</label>
                    <input
                      style={s.input}
                      type="email"
                      placeholder="admin@manit.ac.in"
                      value={registerForm.email}
                      onChange={e => setRegisterForm(p => ({ ...p, email: e.target.value }))}
                    />
                  </div>
                </div>

                <div style={s.fieldGroup}>
                  <label style={s.label}>Website (optional)</label>
                  <input
                    style={s.input}
                    placeholder="https://manit.ac.in"
                    value={registerForm.website}
                    onChange={e => setRegisterForm(p => ({ ...p, website: e.target.value }))}
                  />
                </div>

                <div style={s.fieldGroup}>
                  <label style={s.label}>Credential Types Needed * <span style={{ color: '#484f58', fontWeight: 400 }}>(select all that apply)</span></label>
                  <div style={s.credTypesGrid}>
                    {CREDENTIAL_TYPES.map(ct => {
                      const selected = registerForm.credential_types.includes(ct.id);
                      return (
                        <button
                          key={ct.id}
                          style={{
                            ...s.credTypeBtn,
                            ...(selected ? s.credTypeBtnSelected : {}),
                          }}
                          onClick={() => toggleCredType(ct.id)}
                        >
                          <span>{ct.icon}</span>
                          <span style={{ fontSize: 12 }}>{ct.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {errorMsg && (
                  <div style={s.formError}>{errorMsg}</div>
                )}

                <button
                  style={{
                    ...s.submitBtn,
                    opacity: submitState === 'loading' ? 0.7 : 1,
                  }}
                  onClick={handleRegister}
                  disabled={submitState === 'loading'}
                >
                  {submitState === 'loading'
                    ? '⏳ Generating your institute DID...'
                    : '🚀 Register Institute & Generate Keys →'}
                </button>

                <p style={s.formFootnote}>
                  By registering you agree to our Terms of Service and Privacy Policy.
                  Your private key is generated client-side and never stored by ZK-Auth.
                </p>
              </>
            )}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          FOOTER
      ══════════════════════════════════════════════════════════════ */}
      <footer id="footer" style={s.footer}>
        <div style={s.footerInner}>
          <div style={s.footerTop}>
            {/* Brand */}
            <div style={s.footerBrand}>
              <div style={s.navLogo}>
                <div style={s.navLogoMark}><span style={{ fontSize: 18, fontWeight: 900 }}>ZK</span></div>
                <span style={s.navLogoText}>ZK-Auth</span>
              </div>
              <p style={s.footerTagline}>
                Zero-knowledge credential infrastructure for institutions that take privacy seriously.
              </p>
              <p style={s.footerResearch}>
                📄 Springer Nature · FrontSci 2025 · Accepted
              </p>
            </div>

            {/* Links */}
            {[
              {
                title: 'Platform',
                links: ['Features', 'How It Works', 'Pricing', 'Security', 'Roadmap'],
              },
              {
                title: 'Developers',
                links: ['Documentation', 'API Reference', 'SDK', 'GitHub', 'Changelog'],
              },
              {
                title: 'Company',
                links: ['About', 'Research', 'Blog', 'Careers', 'Contact'],
              },
              {
                title: 'Legal',
                links: ['Privacy Policy', 'Terms of Service', 'DPDP Compliance', 'GDPR', 'Cookie Policy'],
              },
            ].map(col => (
              <div key={col.title} style={s.footerCol}>
                <p style={s.footerColTitle}>{col.title}</p>
                {col.links.map(link => (
                  <a key={link} href="#" style={s.footerLink}>{link}</a>
                ))}
              </div>
            ))}
          </div>

          <div style={s.footerBottom}>
            <p style={s.footerCopy}>
              © {new Date().getFullYear()} ZK-Auth Platform. Built at MANIT Bhopal.
              Research supervised by Dr. Namita Tiwari &amp; Dr. Meenu Chawla.
            </p>
            <div style={s.footerBottomLinks}>
              <span style={{ color: '#484f58', fontSize: 12 }}>
                Groth16 · BN254 · Poseidon · Ed25519 · W3C DID 1.0 · W3C VC 2.0
              </span>
            </div>
          </div>
        </div>
      </footer>

    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root:             { minHeight: '100vh', background: '#010409', color: '#e6edf3',
                      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
                      overflowX: 'hidden' },

  // NAV
  nav:              { position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100,
                      padding: '0 24px', transition: 'all 0.2s' },
  navScrolled:      { background: 'rgba(1,4,9,0.92)', backdropFilter: 'blur(12px)',
                      borderBottom: '1px solid #21262d' },
  navInner:         { maxWidth: 1200, margin: '0 auto', display: 'flex', alignItems: 'center',
                      justifyContent: 'space-between', height: 64 },
  navLogo:          { display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' },
  navLogoMark:      { width: 34, height: 34, background: 'linear-gradient(135deg,#1f6feb,#388bfd)',
                      borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: '#fff' },
  navLogoText:      { fontSize: 18, fontWeight: 800, color: '#e6edf3', letterSpacing: -0.5 },
  navLogoBadge:     { fontSize: 10, background: '#1f6feb22', border: '1px solid #1f6feb44',
                      color: '#79c0ff', padding: '2px 7px', borderRadius: 20, fontWeight: 700 },
  navLinks:         { display: 'flex', gap: 4 },
  navLink:          { background: 'none', border: 'none', color: '#8b949e', padding: '6px 12px',
                      fontSize: 14, cursor: 'pointer', borderRadius: 6, fontWeight: 500,
                      transition: 'color 0.15s' },
  navCtas:          { display: 'flex', alignItems: 'center', gap: 10 },
  navSignIn:        { color: '#8b949e', fontSize: 14, textDecoration: 'none', padding: '6px 12px' },
  navGetStarted:    { background: 'linear-gradient(135deg,#1f6feb,#388bfd)', border: 'none',
                      color: '#fff', padding: '8px 18px', borderRadius: 8, fontSize: 14,
                      fontWeight: 700, cursor: 'pointer' },

  // HERO
  hero:             { minHeight: '100vh', display: 'flex', alignItems: 'center',
                      padding: '100px 24px 60px', position: 'relative', overflow: 'hidden',
                      maxWidth: 1200, margin: '0 auto', gap: 48 },
  heroGrid:         { position: 'fixed', inset: 0, zIndex: 0,
                      backgroundImage: 'linear-gradient(rgba(31,111,235,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(31,111,235,0.04) 1px, transparent 1px)',
                      backgroundSize: '60px 60px', pointerEvents: 'none' },
  heroGlow:         { position: 'absolute', top: '20%', left: '50%', transform: 'translate(-50%,-50%)',
                      width: 600, height: 600, borderRadius: '50%',
                      background: 'radial-gradient(circle, rgba(31,111,235,0.08) 0%, transparent 70%)',
                      pointerEvents: 'none', zIndex: 0 },
  heroContent:      { flex: 1, position: 'relative', zIndex: 1, maxWidth: 620 },
  heroBadge:        { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 14px',
                      background: '#1f6feb15', border: '1px solid #1f6feb40', borderRadius: 20,
                      fontSize: 12, color: '#79c0ff', fontWeight: 600, marginBottom: 28 },
  heroBadgeDot:     { width: 7, height: 7, borderRadius: '50%', background: '#4ade80',
                      boxShadow: '0 0 8px #4ade80' },
  heroTitle:        { fontSize: 52, fontWeight: 900, lineHeight: 1.12, margin: '0 0 20px',
                      letterSpacing: -1.5, color: '#f0f6fc' },
  heroTitleAccent:  { background: 'linear-gradient(135deg,#388bfd,#4ade80)',
                      WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' },
  heroSub:          { fontSize: 17, color: '#8b949e', lineHeight: 1.7, margin: '0 0 32px',
                      maxWidth: 540 },
  heroCtas:         { display: 'flex', gap: 14, marginBottom: 36, flexWrap: 'wrap' },
  heroCtaPrimary:   { background: 'linear-gradient(135deg,#1f6feb,#388bfd)', border: 'none',
                      color: '#fff', padding: '14px 28px', borderRadius: 10, fontSize: 15,
                      fontWeight: 700, cursor: 'pointer', boxShadow: '0 4px 24px rgba(56,139,253,0.35)' },
  heroCtaSecondary: { display: 'flex', alignItems: 'center', color: '#8b949e', fontSize: 15,
                      textDecoration: 'none', padding: '14px 20px', border: '1px solid #30363d',
                      borderRadius: 10, fontWeight: 600, background: 'none' },
  trustBar:         { display: 'flex', gap: 10, flexWrap: 'wrap' },
  trustItem:        { fontSize: 12, color: '#484f58', padding: '4px 10px',
                      border: '1px solid #21262d', borderRadius: 20, background: '#0d1117' },

  // Hero visual
  heroVisual:       { flex: '0 0 340px', position: 'relative', zIndex: 1 },
  archCard:         { background: '#0d1117', border: '1px solid #21262d', borderRadius: 16,
                      padding: 24, boxShadow: '0 20px 60px rgba(0,0,0,0.4)' },
  archTitle:        { margin: '0 0 16px', fontSize: 12, color: '#484f58', fontWeight: 700,
                      textTransform: 'uppercase', letterSpacing: '0.1em' },
  archRow:          { display: 'flex', alignItems: 'center', gap: 12, padding: 12,
                      background: '#161b22', border: '1px solid', borderRadius: 8, marginBottom: 2 },
  archIcon:         { fontSize: 22, flexShrink: 0 },
  archRole:         { margin: 0, fontSize: 13, fontWeight: 700 },
  archSub:          { margin: 0, fontSize: 11, color: '#484f58', marginTop: 2 },
  archArrow:        { textAlign: 'center', padding: '4px 0', fontSize: 16, color: '#21262d' },

  // STATS
  statsSection:     { display: 'flex', justifyContent: 'center', gap: 0,
                      background: '#0d1117', borderTop: '1px solid #21262d',
                      borderBottom: '1px solid #21262d' },
  statCard:         { padding: '32px 48px', textAlign: 'center', borderRight: '1px solid #21262d',
                      flex: 1 },
  statNum:          { margin: 0, fontSize: 36, fontWeight: 900, color: '#e6edf3',
                      letterSpacing: -1, fontVariantNumeric: 'tabular-nums' },
  statLabel:        { margin: '6px 0 0', fontSize: 12, color: '#484f58', fontWeight: 600 },

  // SECTIONS
  section:          { padding: '96px 24px' },
  sectionHeader:    { textAlign: 'center', maxWidth: 640, margin: '0 auto 64px' },
  sectionBadge:     { display: 'inline-block', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
                      textTransform: 'uppercase', color: '#388bfd', padding: '4px 12px',
                      background: '#1f6feb15', border: '1px solid #1f6feb30', borderRadius: 20,
                      marginBottom: 16 },
  sectionTitle:     { margin: '0 0 16px', fontSize: 38, fontWeight: 900, letterSpacing: -1,
                      lineHeight: 1.15, color: '#f0f6fc' },
  sectionSub:       { margin: 0, fontSize: 16, color: '#8b949e', lineHeight: 1.7 },

  // COMPARE
  compareGrid:      { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, maxWidth: 900, margin: '0 auto' },
  compareCard:      { background: '#0d1117', border: '1px solid', borderRadius: 14, overflow: 'hidden' },
  compareHeader:    { padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 },
  compareTitle:     { margin: 0, fontSize: 16, fontWeight: 800 },
  compareItem:      { display: 'flex', gap: 10, padding: '8px 20px', alignItems: 'flex-start' },

  // HOW IT WORKS
  stepsGrid:        { display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 32, maxWidth: 1000, margin: '0 auto 48px' },
  stepsCol:         { display: 'flex', flexDirection: 'column', gap: 24 },
  stepsColTitle:    { margin: '0 0 8px', fontSize: 14, fontWeight: 800, color: '#8b949e',
                      textTransform: 'uppercase', letterSpacing: '0.08em' },
  step:             { display: 'flex', gap: 16, alignItems: 'flex-start' },
  stepNum:          { flexShrink: 0, width: 36, height: 36, borderRadius: 8,
                      background: '#0d2149', border: '1px solid #1f6feb44', color: '#388bfd',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 13, fontWeight: 900, letterSpacing: -0.5 },
  stepTitle:        { margin: '0 0 4px', fontSize: 15, fontWeight: 700, color: '#e6edf3' },
  stepDesc:         { margin: 0, fontSize: 13, color: '#8b949e', lineHeight: 1.6 },
  stepsDivider:     { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, paddingTop: 48 },
  stepsDividerLine: { width: 1, flex: 1, background: 'linear-gradient(to bottom, transparent, #21262d, transparent)' },
  stepsDividerBadge:{ padding: '12px 16px', background: '#0d1117', border: '1px solid #388bfd44',
                      borderRadius: 10, fontSize: 12, color: '#388bfd', fontWeight: 800,
                      textAlign: 'center', lineHeight: 1.4 },
  analogyBox:       { display: 'flex', gap: 20, padding: '24px 28px',
                      background: '#0d1117', border: '1px solid #f0883e33', borderRadius: 14,
                      maxWidth: 900, margin: '0 auto', alignItems: 'flex-start' },
  analogyIcon:      { fontSize: 40, flexShrink: 0, marginTop: 4 },
  analogyTitle:     { margin: '0 0 8px', fontSize: 16, fontWeight: 800, color: '#f0883e' },
  analogyText:      { margin: 0, fontSize: 14, color: '#8b949e', lineHeight: 1.7 },

  // FEATURES
  featuresGrid:     { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, maxWidth: 1100, margin: '0 auto' },
  featureCard:      { background: '#0d1117', border: '1px solid #21262d', borderRadius: 14,
                      padding: '24px', transition: 'border-color 0.2s' },
  featureIconWrap:  { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  featureIcon:      { fontSize: 32 },
  featureTag:       { fontSize: 10, color: '#388bfd', background: '#1f6feb15', border: '1px solid #1f6feb30',
                      padding: '3px 8px', borderRadius: 20, fontWeight: 700, letterSpacing: '0.06em',
                      textTransform: 'uppercase' },
  featureTitle:     { margin: '0 0 10px', fontSize: 16, fontWeight: 700, color: '#e6edf3' },
  featureDesc:      { margin: 0, fontSize: 13, color: '#8b949e', lineHeight: 1.65 },

  // USE CASES
  useCasesGrid:     { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, maxWidth: 1100, margin: '0 auto' },
  useCaseCard:      { background: '#0d1117', border: '1px solid', borderRadius: 14, overflow: 'hidden' },
  useCaseHeader:    { padding: '20px 20px 16px', display: 'flex', alignItems: 'center', gap: 14 },
  useCaseSector:    { margin: 0, fontSize: 18, fontWeight: 800 },
  useCaseBody:      { padding: '0 20px 20px' },
  useCaseLabel:     { margin: '12px 0 4px', fontSize: 10, color: '#484f58', fontWeight: 700,
                      textTransform: 'uppercase', letterSpacing: '0.08em' },
  useCaseOrgs:      { margin: 0, fontSize: 13, color: '#8b949e' },
  useCaseCreds:     { margin: 0, fontSize: 13, color: '#c9d1d9' },

  // PRICING
  pricingGrid:      { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, maxWidth: 1100, margin: '0 auto 32px' },
  pricingCard:      { background: '#0d1117', border: '1px solid #21262d', borderRadius: 14,
                      padding: '28px 24px', display: 'flex', flexDirection: 'column',
                      gap: 8, position: 'relative' },
  pricingCardHighlight: { border: '2px solid #238636', background: '#0a1d0f',
                          boxShadow: '0 0 40px rgba(35,134,54,0.15)' },
  pricingBadge:     { position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)',
                      background: '#238636', color: '#fff', padding: '3px 14px', borderRadius: 20,
                      fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap' },
  pricingName:      { margin: 0, fontSize: 14, fontWeight: 700, color: '#8b949e', textTransform: 'uppercase',
                      letterSpacing: '0.08em' },
  pricingPriceRow:  { display: 'flex', alignItems: 'baseline', gap: 4, margin: '8px 0 4px' },
  pricingPrice:     { fontSize: 36, fontWeight: 900, color: '#e6edf3', letterSpacing: -1 },
  pricingPeriod:    { fontSize: 14, color: '#484f58' },
  pricingTagline:   { margin: '0 0 16px', fontSize: 13, color: '#8b949e' },
  pricingDivider:   { height: 1, background: '#21262d', margin: '4px 0 12px' },
  pricingFeatureRow:{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8 },
  pricingCta:       { width: '100%', background: '#161b22', border: '1px solid #30363d',
                      color: '#c9d1d9', borderRadius: 8, padding: '11px', fontSize: 13,
                      fontWeight: 700, cursor: 'pointer', marginTop: 'auto' },
  pricingCtaHighlight: { background: 'linear-gradient(135deg,#238636,#2ea043)', border: 'none', color: '#fff' },
  pricingNote:      { textAlign: 'center', fontSize: 12, color: '#484f58', maxWidth: 700, margin: '0 auto' },

  // REGISTER
  registerGrid:     { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 64, maxWidth: 1100, margin: '0 auto',
                      alignItems: 'start' },
  registerLeft:     { position: 'sticky', top: 88 },
  registerChecklist:{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 10 },
  registerCheckItem:{ margin: 0, fontSize: 13, color: '#4ade80', lineHeight: 1.5 },
  registerPlanSelected: { display: 'flex', alignItems: 'center', marginTop: 28, padding: '12px 16px',
                          background: '#0d1117', border: '1px solid #238636', borderRadius: 10 },
  changePlanBtn:    { background: 'none', border: 'none', color: '#388bfd', fontSize: 12,
                      cursor: 'pointer', marginLeft: 'auto', textDecoration: 'underline' },
  registerForm:     { background: '#0d1117', border: '1px solid #21262d', borderRadius: 16, padding: 32 },
  formTitle:        { margin: '0 0 24px', fontSize: 20, fontWeight: 800, color: '#e6edf3' },
  formGrid:         { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 },
  fieldGroup:       { marginBottom: 18 },
  label:            { display: 'block', fontSize: 11, color: '#8b949e', marginBottom: 6,
                      fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' },
  input:            { width: '100%', background: '#161b22', border: '1px solid #30363d', borderRadius: 8,
                      color: '#e6edf3', padding: '10px 12px', fontSize: 14, boxSizing: 'border-box',
                      outline: 'none' },
  credTypesGrid:    { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 8 },
  credTypeBtn:      { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                      padding: '10px 8px', background: '#161b22', border: '1px solid #30363d',
                      borderRadius: 8, cursor: 'pointer', color: '#8b949e', transition: 'all 0.15s' },
  credTypeBtnSelected: { background: '#0d2149', border: '1px solid #388bfd', color: '#79c0ff' },
  formError:        { background: '#1a0505', border: '1px solid #6e1f1f', borderRadius: 8,
                      color: '#f87171', fontSize: 13, padding: '10px 14px', marginBottom: 16 },
  submitBtn:        { width: '100%', background: 'linear-gradient(135deg,#238636,#2ea043)', border: 'none',
                      color: '#fff', borderRadius: 10, padding: '15px', fontSize: 15, fontWeight: 800,
                      cursor: 'pointer', boxShadow: '0 4px 20px rgba(35,134,54,0.3)', marginBottom: 14 },
  formFootnote:     { margin: 0, fontSize: 11, color: '#484f58', lineHeight: 1.6, textAlign: 'center' },

  // SUCCESS
  successPanel:     { textAlign: 'center', padding: '20px 0' },
  successIcon:      { fontSize: 60, marginBottom: 16 },
  successTitle:     { margin: '0 0 12px', fontSize: 22, fontWeight: 800, color: '#4ade80' },
  successText:      { margin: '0 0 20px', fontSize: 14, color: '#8b949e', lineHeight: 1.6 },
  successChecks:    { background: '#0a1d0f', border: '1px solid #238636', borderRadius: 10,
                      padding: '16px 20px', textAlign: 'left' },

  // FOOTER
  footer:           { background: '#080c10', borderTop: '1px solid #21262d', padding: '60px 24px 32px' },
  footerInner:      { maxWidth: 1200, margin: '0 auto' },
  footerTop:        { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr', gap: 40, marginBottom: 48 },
  footerBrand:      { display: 'flex', flexDirection: 'column', gap: 12 },
  footerTagline:    { margin: 0, fontSize: 13, color: '#484f58', lineHeight: 1.6, maxWidth: 280 },
  footerResearch:   { margin: 0, fontSize: 12, color: '#388bfd', fontWeight: 600 },
  footerCol:        { display: 'flex', flexDirection: 'column', gap: 10 },
  footerColTitle:   { margin: '0 0 4px', fontSize: 12, fontWeight: 800, color: '#8b949e',
                      textTransform: 'uppercase', letterSpacing: '0.08em' },
  footerLink:       { fontSize: 13, color: '#484f58', textDecoration: 'none' },
  footerBottom:     { display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      borderTop: '1px solid #21262d', paddingTop: 24 },
  footerCopy:       { margin: 0, fontSize: 12, color: '#484f58' },
  footerBottomLinks:{ display: 'flex', gap: 20 },
};
