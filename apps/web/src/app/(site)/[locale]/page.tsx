import {
  ButtonLink,
  Callout,
  CtaBand,
  Faq,
  FeatureGrid,
  Hero,
  HeroAccent,
  JourneyTimeline,
  Notice,
  Pricing,
  Section,
  StepList,
  TrustStrip,
} from '@integris/ui';
import {
  Building,
  CodeXml,
  RotateCcwClock,
  Languages,
  MessageSquareText,
  ShieldCheck,
  Smartphone,
  SpellCheck,
  Users,
  Wallet,
  Zap,
} from 'lucide-react';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { PublicFooter } from '../../../components/PublicFooter';
import { PublicHeader } from '../../../components/PublicHeader';
import { getPathname } from '../../../i18n/navigation';
import { toPlanCard } from '../../../lib/plan-display';
import { fetchPublicPlans } from '../../../lib/plans';

interface HomePageProps {
  params: Promise<{ locale: Locale }>;
}

const icon = { size: 24, strokeWidth: 1.75, 'aria-hidden': true } as const;

export default async function HomePage({ params }: HomePageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Home');
  const tPlans = await getTranslations('Plans');
  const signup = getPathname({ href: '/signup', locale });
  const plans = await fetchPublicPlans();

  const journey = ['template', 'writing', 'review', 'versions', 'pdf'] as const;
  const features = [
    ['editor', CodeXml],
    ['compile', Zap],
    ['realtime', Users],
    ['comments', MessageSquareText],
    ['history', RotateCcwClock],
    ['mobile', Smartphone],
  ] as const;
  const faq = ['latex', 'payment', 'privacy', 'import'] as const;

  return (
    <>
      <PublicHeader locale={locale} path="/" />
      <main>
        <Hero
          eyebrow={t('hero.eyebrow')}
          title={t.rich('hero.title', { accent: (chunks) => <HeroAccent>{chunks}</HeroAccent> })}
          lead={t('hero.lead')}
          actions={
            <>
              <ButtonLink href={signup} variant="accent" size="large" arrow>
                {t('hero.start')}
              </ButtonLink>
              <ButtonLink href="#features" variant="secondary" size="large">
                {t('hero.how')}
              </ButtonLink>
            </>
          }
          note={t('hero.note')}
        >
          <JourneyTimeline
            label={t('journey.label')}
            steps={journey.map((step) => ({
              title: t(`journey.${step}.title`),
              text: t(`journey.${step}.text`),
            }))}
          />
        </Hero>

        <TrustStrip
          label={t('trust.label')}
          items={[
            { icon: <Wallet {...icon} />, label: t('trust.payment') },
            { icon: <Languages {...icon} />, label: t('trust.languages') },
            { icon: <SpellCheck {...icon} />, label: t('trust.errors') },
            { icon: <ShieldCheck {...icon} />, label: t('trust.isolation') },
          ]}
        />

        <Section
          id="features"
          eyebrow={t('features.eyebrow')}
          title={t('features.title')}
          intro={<p>{t('features.intro')}</p>}
        >
          <FeatureGrid
            features={features.map(([key, Icon]) => ({
              icon: <Icon {...icon} />,
              title: t(`features.${key}.title`),
              text: t(`features.${key}.text`),
            }))}
          />
        </Section>

        <Section
          id="supervision"
          tone="muted"
          eyebrow={t('supervision.eyebrow')}
          title={t('supervision.title')}
          intro={<p>{t('supervision.intro')}</p>}
        >
          <StepList
            steps={(['share', 'submit', 'validate'] as const).map((step) => ({
              title: t(`supervision.${step}.title`),
              text: t(`supervision.${step}.text`),
            }))}
          />
          <Callout
            icon={<Building {...icon} />}
            title={t('supervision.orgs.title')}
            text={t('supervision.orgs.text')}
            points={(['team', 'dashboard', 'groups', 'exams'] as const).map((point) =>
              t(`supervision.orgs.${point}`),
            )}
          />
        </Section>

        <Section
          id="pricing"
          eyebrow={t('pricing.eyebrow')}
          title={t('pricing.title')}
          intro={<p>{t('pricing.intro')}</p>}
        >
          {plans && plans.length > 0 ? (
            <Pricing
              periodLabel={t('pricing.period')}
              periodNames={{ monthly: t('pricing.monthly'), yearly: t('pricing.yearly') }}
              plans={plans.map((plan) => toPlanCard(plan, tPlans, { locale, signupHref: signup }))}
            />
          ) : (
            <Notice>{t('pricing.unavailable')}</Notice>
          )}
        </Section>

        <Section id="faq" tone="muted" eyebrow={t('faq.eyebrow')} title={t('faq.title')}>
          <Faq
            items={faq.map((item) => ({
              question: t(`faq.${item}.question`),
              answer: t(`faq.${item}.answer`),
            }))}
          />
        </Section>

        <CtaBand
          title={t('cta.title')}
          text={t('cta.text')}
          action={
            <ButtonLink href={signup} variant="accent" size="large" arrow>
              {t('cta.action')}
            </ButtonLink>
          }
        />
      </main>
      <PublicFooter locale={locale} />
    </>
  );
}
