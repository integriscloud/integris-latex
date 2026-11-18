import { Clock } from 'lucide-react';
import { ButtonLink } from '../button/Button';
import { Container } from '../container/Container';
import styles from './coming-soon.module.css';

export interface ComingSoonProps {
  title: string;
  text: string;
  back: { href: string; label: string };
}

/** Placeholder page for a screen that is not built yet. */
export function ComingSoon({ title, text, back }: ComingSoonProps) {
  return (
    <Container className={styles.page}>
      <span className={styles.icon}>
        <Clock size={24} strokeWidth={1.75} aria-hidden="true" />
      </span>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.text}>{text}</p>
      <ButtonLink href={back.href} variant="secondary">
        {back.label}
      </ButtonLink>
    </Container>
  );
}
