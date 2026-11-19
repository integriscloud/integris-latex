import { ChevronRight } from 'lucide-react';
import styles from './version-timeline.module.css';

export interface TimelineItem {
  id: string;
  title: string;
  /** Second line: kind, date, author ("Version nommée · hier, 18 h 40"). */
  meta: string;
  /** current: the project now; named: a named version; auto: an automatic one. */
  tone: 'current' | 'named' | 'auto';
}

export interface VersionTimelineProps {
  items: readonly TimelineItem[];
  label: string;
  /** Opens a version; the current state is not a button. */
  onSelect?: (id: string) => void;
}

/** Versions of a project, most recent first, as a vertical timeline. */
export function VersionTimeline({ items, label, onSelect }: VersionTimelineProps) {
  return (
    <ol className={styles.timeline} aria-label={label}>
      {items.map((item) => {
        const body = (
          <>
            <span className={styles.title}>{item.title}</span>
            <span className={styles.meta}>{item.meta}</span>
          </>
        );
        return (
          <li key={item.id} className={`${styles.item} ${styles[item.tone]}`}>
            <span className={styles.rail} aria-hidden="true">
              <span className={styles.dot} />
              <span className={styles.line} />
            </span>
            {item.tone === 'current' || !onSelect ? (
              <span className={styles.body}>{body}</span>
            ) : (
              <button type="button" className={styles.body} onClick={() => onSelect(item.id)}>
                {body}
                <ChevronRight
                  className={styles.chevron}
                  size={16}
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}
