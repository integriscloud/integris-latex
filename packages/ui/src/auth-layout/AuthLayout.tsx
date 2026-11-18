import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import styles from './auth-layout.module.css';

export interface AuthFeature {
  icon: LucideIcon;
  title: string;
  text: string;
}

export interface AuthSplitLayoutProps {
  /** Inverted logo for the dark column. */
  brand: ReactNode;
  /** Regular logo above the form on phones and tablets, where the dark column comes last. */
  compactBrand?: ReactNode;
  title: string;
  text: string;
  features: readonly AuthFeature[];
  /** Top right of the form column, e.g. the language switcher. */
  tools?: ReactNode;
  children: ReactNode;
}

/** Sign-in screen: dark presentation column and the form column. */
export function AuthSplitLayout({
  brand,
  compactBrand,
  title,
  text,
  features,
  tools,
  children,
}: AuthSplitLayoutProps) {
  return (
    <div className={styles.split}>
      <aside className={styles.aside}>
        {brand}
        <div className={styles.asideHead}>
          <p className={styles.asideTitle}>{title}</p>
          <p className={styles.asideText}>{text}</p>
        </div>
        <ul className={styles.features}>
          {features.map(({ icon: Icon, title: featureTitle, text: featureText }) => (
            <li key={featureTitle} className={styles.feature}>
              <span className={styles.featureIcon} aria-hidden="true">
                <Icon size={20} strokeWidth={1.75} />
              </span>
              <span className={styles.featureText}>
                <span className={styles.featureTitle}>{featureTitle}</span>
                {featureText}
              </span>
            </li>
          ))}
        </ul>
      </aside>
      <main className={styles.main}>
        <div className={styles.mainTop}>
          {compactBrand && <div className={styles.compactBrand}>{compactBrand}</div>}
          {tools}
        </div>
        <div className={styles.mainBody}>
          <div className={styles.panel}>{children}</div>
        </div>
      </main>
    </div>
  );
}

export interface AuthPageLayoutProps {
  brand: ReactNode;
  /** Right side of the top bar: links, language switcher, user. */
  barEnd?: ReactNode;
  /** Side column (e.g. the sign-up steps); stacks above the content on small screens. */
  side?: ReactNode;
  narrow?: boolean;
  children: ReactNode;
}

/** Account screens: a light top bar and a centered column, with an optional side column. */
export function AuthPageLayout({ brand, barEnd, side, narrow, children }: AuthPageLayoutProps) {
  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        {brand}
        {barEnd && <div className={styles.barEnd}>{barEnd}</div>}
      </header>
      <main
        className={[styles.content, side && styles.withSide, narrow && styles.narrow]
          .filter(Boolean)
          .join(' ')}
      >
        <div className={styles.column}>{children}</div>
        {side && <aside className={styles.side}>{side}</aside>}
      </main>
    </div>
  );
}

export function AuthHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className={styles.heading}>
      <h1 className={styles.title}>{title}</h1>
      {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
    </div>
  );
}

export function AuthCard({ children }: { children: ReactNode }) {
  return <div className={styles.card}>{children}</div>;
}

export function AuthSideSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className={styles.sideTitle}>{title}</h2>
      {children}
    </section>
  );
}
