import type { ReactNode } from 'react';
import styles from './page-header.module.css';

export interface PageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  /** Link back to the parent page, above the title. */
  back?: ReactNode;
  actions?: ReactNode;
}

/** Title of an application page (serif), with its main actions on the right. */
export function PageHeader({ title, subtitle, back, actions }: PageHeaderProps) {
  return (
    <div className={styles.header}>
      <div className={styles.text}>
        {back}
        <h1 className={styles.title}>{title}</h1>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}

/** Card holding a section of a page (mockup: white, 16 px radius). */
export function Panel({
  title,
  actions,
  children,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.panel}>
      {(title || actions) && (
        <div className={styles.panelHead}>
          {title && <h2 className={styles.panelTitle}>{title}</h2>}
          {actions && <div className={styles.actions}>{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
