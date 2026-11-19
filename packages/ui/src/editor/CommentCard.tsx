import type { ReactNode } from 'react';
import styles from './comment-card.module.css';

export interface CommentMessage {
  key: string;
  author: string;
  /** Initials shown in the avatar ("KS"). */
  initials: string;
  /** Avatar color: gold or green, as in the design system. */
  tone: 'accent' | 'action';
  /** "il y a 2 h". */
  time: string;
  body: string;
}

export interface CommentCardProps {
  /** The commented text, shown as a quote. */
  quote: string;
  /** Under the quote: the file, or why the text is no longer in it. */
  quoteNote?: string;
  /** Goes to the commented text (the quote becomes a button). */
  onShow?: () => void;
  showLabel?: string;
  /** The comment, then its replies. */
  messages: readonly CommentMessage[];
  /** Replacement proposal: the quoted text, the proposed text and its state. */
  suggestion?: { label: string; from: string; to: string; state?: ReactNode };
  /** Badges (resolved…), shown next to the quote. */
  status?: ReactNode;
  /** Highlighted: the comment of the text under the cursor. */
  active?: boolean;
  resolved?: boolean;
  /** Reply form, buttons. */
  children?: ReactNode;
  actions?: ReactNode;
}

/** Comment anchored to a selection of text, with its replies and replacement proposal. */
export function CommentCard({
  quote,
  quoteNote,
  onShow,
  showLabel,
  messages,
  suggestion,
  status,
  active,
  resolved,
  children,
  actions,
}: CommentCardProps) {
  const quoteText = <span className={styles.quoteText}>« {quote} »</span>;
  return (
    <article
      className={[styles.card, active && styles.active, resolved && styles.resolved]
        .filter(Boolean)
        .join(' ')}
    >
      <div className={styles.head}>
        {onShow ? (
          <button type="button" className={styles.quote} onClick={onShow} title={showLabel}>
            {quoteText}
          </button>
        ) : (
          <p className={styles.quote}>{quoteText}</p>
        )}
        {status && <div className={styles.status}>{status}</div>}
      </div>
      {quoteNote && <p className={styles.note}>{quoteNote}</p>}
      <ol className={styles.messages}>
        {messages.map((message) => (
          <li key={message.key} className={styles.message}>
            <span className={`${styles.avatar} ${styles[message.tone]}`} aria-hidden="true">
              {message.initials}
            </span>
            <div className={styles.messageBody}>
              <p className={styles.meta}>
                <strong>{message.author}</strong> <span>· {message.time}</span>
              </p>
              <p className={styles.text}>{message.body}</p>
            </div>
          </li>
        ))}
      </ol>
      {suggestion && (
        <div className={styles.suggestion}>
          <p className={styles.suggestionLabel}>{suggestion.label}</p>
          <p className={styles.diff}>
            <del>{suggestion.from}</del>
            {suggestion.to && <ins>{suggestion.to}</ins>}
          </p>
          {suggestion.state}
        </div>
      )}
      {children}
      {actions && <div className={styles.actions}>{actions}</div>}
    </article>
  );
}
