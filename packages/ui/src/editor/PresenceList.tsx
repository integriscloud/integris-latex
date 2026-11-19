import styles from './presence-list.module.css';

export interface PresencePerson {
  /** Stable key (a connection of the person). */
  key: string;
  name: string;
  /** Index of the `--presence-N` token (1 to 6), the color of the person's cursor. */
  color: number;
  /** Shown with the name: where the person is ("main.tex"). */
  detail?: string;
}

export interface PresenceListProps {
  people: readonly PresencePerson[];
  /** Accessible name of the list ("Personnes en ligne"). */
  label: string;
  /** Text of the counter of people not shown ("+2"). */
  moreLabel: (count: number) => string;
  /** At most this many avatars; the others are counted. */
  max?: number;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('') || '?';

/** People online in a project, in the color of their cursor. */
export function PresenceList({ people, label, moreLabel, max = 4 }: PresenceListProps) {
  if (!people.length) return null;
  const shown = people.slice(0, max);
  const more = people.length - shown.length;
  const all = people.map((person) => describe(person)).join(', ');
  return (
    <ul className={styles.list} aria-label={label}>
      {shown.map((person) => (
        <li
          key={person.key}
          className={`${styles.avatar} ${styles[`color${person.color}`]}`}
          title={describe(person)}
        >
          <span aria-hidden="true">{initials(person.name)}</span>
          <span className={styles.hidden}>{describe(person)}</span>
        </li>
      ))}
      {more > 0 && (
        <li className={`${styles.avatar} ${styles.more}`} title={all}>
          <span aria-hidden="true">{moreLabel(more)}</span>
          <span className={styles.hidden}>
            {people
              .slice(max)
              .map((person) => describe(person))
              .join(', ')}
          </span>
        </li>
      )}
    </ul>
  );
}

function describe(person: PresencePerson) {
  return person.detail ? `${person.name} (${person.detail})` : person.name;
}
