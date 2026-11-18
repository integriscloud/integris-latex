import { Languages } from 'lucide-react';
import styles from './language-switcher.module.css';

export interface LanguageOption {
  locale: string;
  /** Short visible label, e.g. "FR". */
  label: string;
  /** Full language name for assistive technologies, e.g. "Français". */
  name: string;
  href: string;
}

export interface LanguageSwitcherProps {
  /** Accessible name of the navigation landmark (translated by the caller). */
  label: string;
  current: string;
  options: readonly LanguageOption[];
}

export function LanguageSwitcher({ label, current, options }: LanguageSwitcherProps) {
  return (
    <nav aria-label={label} className={styles.switcher}>
      <Languages size={20} strokeWidth={1.75} aria-hidden="true" />
      <ul className={styles.list}>
        {options.map((option) => (
          <li key={option.locale}>
            <a
              className={styles.option}
              href={option.href}
              hrefLang={option.locale}
              lang={option.locale}
              aria-label={option.name}
              aria-current={option.locale === current ? 'true' : undefined}
            >
              {option.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
