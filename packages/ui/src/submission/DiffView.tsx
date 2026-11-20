import { Badge } from '../badge/Badge';
import styles from './diff-view.module.css';

export interface DiffViewLine {
  type: 'same' | 'added' | 'removed';
  text: string;
  from: number | null;
  to: number | null;
  /** Words changed inside the line (paired with the line it replaces). */
  segments?: { text: string; changed: boolean }[];
}

export interface DiffViewProps {
  path: string;
  /** Translated kind of change (modified, added…). */
  changeLabel: string;
  hunks: { lines: DiffViewLine[] }[];
  added: number;
  removed: number;
  /** Shown instead of the lines (binary file, too large, unchanged). */
  note?: string;
  labels: { added: string; removed: string; lines: string };
}

const SIGN = { same: ' ', added: '+', removed: '−' } as const;

/**
 * Line-by-line differences of one file between two versions: hunks of changed lines with their
 * context, older and newer line numbers. Inside a changed line, the words changed are marked
 * (strong background, struck through when removed). Changes are told by the sign and the
 * screen-reader labels too, never by the color alone.
 */
export function DiffView({
  path,
  changeLabel,
  hunks,
  added,
  removed,
  note,
  labels,
}: DiffViewProps) {
  return (
    <section className={styles.file} aria-label={path}>
      <div className={styles.head}>
        <span className={styles.path}>{path}</span>
        <span className={styles.counts}>
          <Badge>{changeLabel}</Badge>
          {added > 0 && <span className={styles.plus}>+{added}</span>}
          {removed > 0 && <span className={styles.minus}>−{removed}</span>}
        </span>
      </div>
      {note ? (
        <p className={styles.note}>{note}</p>
      ) : (
        <div className={styles.scroll}>
          {hunks.map((hunk, index) => (
            <table key={index} className={styles.table} aria-label={labels.lines}>
              <tbody>
                {hunk.lines.map((line, row) => (
                  <tr key={row} className={line.type === 'same' ? undefined : styles[line.type]}>
                    <td className={styles.number}>{line.from ?? ''}</td>
                    <td className={styles.number}>{line.to ?? ''}</td>
                    <td className={styles.sign} aria-hidden="true">
                      {SIGN[line.type]}
                    </td>
                    <td className={styles.text}>
                      {line.type !== 'same' && (
                        <span className={styles.srOnly}>
                          {line.type === 'added' ? labels.added : labels.removed}{' '}
                        </span>
                      )}
                      {line.segments
                        ? line.segments.map((segment, part) =>
                            segment.changed ? (
                              <mark key={part} className={styles.word}>
                                {segment.text}
                              </mark>
                            ) : (
                              <span key={part}>{segment.text}</span>
                            ),
                          )
                        : line.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </div>
      )}
    </section>
  );
}
