'use client';

import type { CommentAnchor, CommentInfo, ProjectFileInfo, ProjectRights } from '@integris/shared';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  CommentCard,
  type CommentMessage,
  EmptyState,
  Tabs,
  TextAreaField,
} from '@integris/ui';
import { Check, MessageSquarePlus, MessagesSquare } from 'lucide-react';
import { useFormatter, useLocale, useNow, useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { apiPost, type ClientError } from '../../lib/api-client';
import { applyReplacement, rangeOf, revertReplacement } from '../../lib/collab/anchors';
import type { ProjectCollab } from '../../lib/collab/project-collab';
import { relativeOrNow } from '../../lib/format';
import { ConfirmDialog } from '../app/dialogs';
import { useApiErrorMessage } from '../app/use-api-error';
import styles from './editor.module.css';

/** A selection about to be commented. */
export interface CommentDraft {
  fileId: string;
  quotedText: string;
  anchor: CommentAnchor;
}

export interface CommentsPanelProps {
  projectId: string;
  collab: ProjectCollab;
  rights: ProjectRights;
  /** The project is read-only (proposals cannot be applied). */
  readOnly: boolean;
  files: ReadonlyMap<string, ProjectFileInfo>;
  activeFileId: string | null;
  comments: readonly CommentInfo[] | null;
  error: ClientError | null;
  /** Where the comments of the open file are now (null: their text was deleted). */
  ranges: ReadonlyMap<string, { from: number; to: number } | null>;
  activeCommentId: string | null;
  meId: string | null;
  draft: CommentDraft | null;
  /** Why no comment could be started (no selection, selection too long). */
  hint: string | null;
  /** "Comment the selection": the editor reads the selection of the code. */
  onRequestDraft: () => void;
  onCancelDraft: () => void;
  onChanged: (comment: CommentInfo) => void;
  /** Shows the commented text in the code. */
  onShow: (comment: CommentInfo) => void;
}

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');

/**
 * Comments of the project (docs/spec.md, "Commentaires"): anchored to a selection, with replies,
 * resolution, and replacement proposals that the owner or an editor applies in one click or
 * refuses. The reader (Lecteur) only reads them.
 */
export function CommentsPanel(props: CommentsPanelProps) {
  const { projectId, collab, rights, comments, ranges, draft, files, meId } = props;
  const t = useTranslations('Comments');
  const tCommon = useTranslations('Common');
  const locale = useLocale();
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const errorMessage = useApiErrorMessage(locale);

  const [filter, setFilter] = useState<'open' | 'resolved'>('open');
  const [body, setBody] = useState('');
  const [proposing, setProposing] = useState(false);
  const [proposal, setProposal] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [confirming, setConfirming] = useState<{ comment: CommentInfo; current: string } | null>(
    null,
  );

  // A new selection starts a fresh comment (state adjusted during render).
  const [shownDraft, setShownDraft] = useState(draft);
  if (draft !== shownDraft) {
    setShownDraft(draft);
    setBody('');
    setProposing(false);
    setProposal(draft?.quotedText ?? '');
    setError(null);
  }

  const fail = (id: string, cause: ClientError | string) =>
    setError({ id, message: typeof cause === 'string' ? cause : errorMessage(cause) });

  const send = async <T,>(id: string, path: string, data: object) => {
    setBusy(id);
    setError(null);
    const result = await apiPost<T>(`projects/${projectId}/comments${path}`, data);
    setBusy(null);
    if (!result.ok) fail(id, result.error);
    return result.ok ? result.data : null;
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || !body.trim()) return;
    const created = await send<CommentInfo>('draft', '', {
      fileId: draft.fileId,
      anchor: draft.anchor,
      quotedText: draft.quotedText,
      body,
      ...(proposing ? { suggestedText: proposal } : {}),
    });
    if (created) {
      props.onChanged(created);
      props.onCancelDraft();
      setFilter('open');
    }
  };

  const answer = async (event: FormEvent, comment: CommentInfo) => {
    event.preventDefault();
    if (!reply.trim()) return;
    const changed = await send<CommentInfo>(comment.id, `/${comment.id}/replies`, { body: reply });
    if (changed) {
      props.onChanged(changed);
      setReply('');
      setReplyTo(null);
    }
  };

  const resolve = async (comment: CommentInfo, resolved: boolean) => {
    const changed = await send<CommentInfo>(comment.id, `/${comment.id}/resolve`, { resolved });
    if (changed) props.onChanged(changed);
  };

  const refuse = async (comment: CommentInfo) => {
    const changed = await send<CommentInfo>(comment.id, `/${comment.id}/suggestion`, {
      decision: 'REJECTED',
    });
    if (changed) props.onChanged(changed);
  };

  /** Checks the anchored text before applying: changed since the proposal → asks first. */
  const prepareApply = async (comment: CommentInfo) => {
    setError(null);
    if (!comment.fileId) return fail(comment.id, t('fileGone'));
    const session = await collab.whenSynced(comment.fileId).catch(() => null);
    if (!session) return fail(comment.id, { code: 'network' });
    if (!session.snapshot.writable) return fail(comment.id, t('cannotWrite'));
    const range = rangeOf(session.shared.text, comment.anchor);
    if (!range) return fail(comment.id, t('textGone'));
    const current = session.shared.text.toString().slice(range.from, range.to);
    if (current !== comment.quotedText) setConfirming({ comment, current });
    else await apply(comment);
  };

  /**
   * Replaces the text in the shared document (everyone sees it, one undo step), then records the
   * decision. Refused by the server (decided meanwhile, rights changed): the text is put back.
   */
  const apply = async (comment: CommentInfo): Promise<string | null> => {
    const session = collab.session(comment.fileId!);
    if (!session) return t('textGone');
    const applied = applyReplacement(
      session.shared.text,
      comment.anchor,
      comment.suggestedText ?? '',
    );
    if (!applied) {
      fail(comment.id, t('textGone'));
      return t('textGone');
    }
    setBusy(comment.id);
    const result = await apiPost<CommentInfo>(
      `projects/${projectId}/comments/${comment.id}/suggestion`,
      { decision: 'APPLIED', anchor: applied.anchor },
    );
    setBusy(null);
    if (!result.ok) {
      revertReplacement(session.shared.text, applied.anchor, applied.previous, applied.from);
      fail(comment.id, result.error);
      return errorMessage(result.error);
    }
    props.onChanged(result.data);
    return null;
  };

  const list = (comments ?? []).filter((comment) =>
    filter === 'open' ? comment.status === 'OPEN' : comment.status === 'RESOLVED',
  );
  const openCount = (comments ?? []).filter((comment) => comment.status === 'OPEN').length;
  const resolvedCount = (comments?.length ?? 0) - openCount;
  // Comments of the open file first, in the order of the text; the others by date.
  const ordered = [...list].sort((a, b) => {
    const ra = a.fileId === props.activeFileId ? ranges.get(a.id) : undefined;
    const rb = b.fileId === props.activeFileId ? ranges.get(b.id) : undefined;
    if (ra && rb) return ra.from - rb.from;
    if (ra) return -1;
    if (rb) return 1;
    return a.createdAt.localeCompare(b.createdAt);
  });

  const message = (key: string, author: { id: string; name: string }, at: string, text: string) =>
    ({
      key,
      author: author.id === meId ? t('you') : author.name,
      initials: initialsOf(author.name),
      tone: author.id === meId ? 'action' : 'accent',
      time: relativeOrNow(format, new Date(at), now, tCommon('justNow')),
      body: text,
    }) satisfies CommentMessage;

  const card = (comment: CommentInfo) => {
    const file = comment.fileId ? files.get(comment.fileId) : undefined;
    const inActiveFile = comment.fileId === props.activeFileId;
    const range = inActiveFile ? ranges.get(comment.id) : undefined;
    const pending = comment.suggestionStatus === 'PENDING';
    const canDecide = rights.applySuggestion && pending && comment.status === 'OPEN';
    const note = !file
      ? t('fileGone')
      : inActiveFile && range === null
        ? t('textGone')
        : inActiveFile
          ? undefined
          : file.path;
    const suggestionState =
      comment.suggestionStatus === 'APPLIED' ? (
        <Badge tone="success" icon={Check}>
          {t('applied', { name: comment.suggestionDecidedBy?.name ?? '' })}
        </Badge>
      ) : comment.suggestionStatus === 'REJECTED' ? (
        <Badge>{t('rejected', { name: comment.suggestionDecidedBy?.name ?? '' })}</Badge>
      ) : undefined;
    return (
      <li key={comment.id}>
        <CommentCard
          quote={comment.quotedText}
          quoteNote={note}
          onShow={file && range !== null ? () => props.onShow(comment) : undefined}
          showLabel={t('show')}
          active={props.activeCommentId === comment.id}
          resolved={comment.status === 'RESOLVED'}
          status={
            comment.status === 'RESOLVED' && (
              <Badge tone="success" icon={Check}>
                {t('resolvedBadge')}
              </Badge>
            )
          }
          messages={[
            message(comment.id, comment.author, comment.createdAt, comment.body),
            ...comment.replies.map((item) =>
              message(item.id, item.author, item.createdAt, item.body),
            ),
          ]}
          suggestion={
            comment.suggestedText !== null
              ? {
                  label: t('proposal'),
                  from: comment.quotedText,
                  to: comment.suggestedText,
                  state: suggestionState,
                }
              : undefined
          }
          actions={
            <>
              {canDecide && (
                <>
                  <Button
                    busy={busy === comment.id}
                    disabled={props.readOnly || !comment.fileId}
                    onClick={() => void prepareApply(comment)}
                  >
                    {t('apply')}
                  </Button>
                  <Button variant="secondary" onClick={() => void refuse(comment)}>
                    {t('refuse')}
                  </Button>
                </>
              )}
              {rights.comment && replyTo !== comment.id && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setReplyTo(comment.id);
                    setReply('');
                  }}
                >
                  {t('reply')}
                </Button>
              )}
              {comment.canResolve && (
                <Button
                  variant="secondary"
                  onClick={() => void resolve(comment, comment.status === 'OPEN')}
                >
                  {comment.status === 'OPEN' ? (
                    <>
                      <Check size={20} strokeWidth={1.75} aria-hidden="true" />
                      {t('resolve')}
                    </>
                  ) : (
                    t('reopen')
                  )}
                </Button>
              )}
            </>
          }
        >
          {error?.id === comment.id && <Alert tone="error">{error.message}</Alert>}
          {replyTo === comment.id && (
            <form className={styles.commentForm} onSubmit={(event) => void answer(event, comment)}>
              <TextAreaField
                label={t('replyLabel')}
                value={reply}
                rows={2}
                maxLength={4000}
                autoFocus
                onChange={(event) => setReply(event.target.value)}
              />
              <div className={styles.commentFormActions}>
                <Button variant="secondary" onClick={() => setReplyTo(null)}>
                  {t('cancel')}
                </Button>
                <Button type="submit" busy={busy === comment.id} disabled={!reply.trim()}>
                  {t('send')}
                </Button>
              </div>
            </form>
          )}
        </CommentCard>
      </li>
    );
  };

  return (
    <div className={styles.comments}>
      {rights.comment && !draft && (
        <Button variant="secondary" onClick={props.onRequestDraft}>
          <MessageSquarePlus size={20} strokeWidth={1.75} aria-hidden="true" />
          {t('commentSelection')}
        </Button>
      )}
      {!rights.comment && <p className={styles.menuHelp}>{t('readerOnly')}</p>}
      {props.hint && !draft && <Alert tone="info">{props.hint}</Alert>}

      {draft && (
        <form className={styles.commentForm} onSubmit={(event) => void create(event)}>
          <p className={styles.commentQuote}>« {draft.quotedText} »</p>
          <TextAreaField
            label={t('newLabel')}
            value={body}
            maxLength={4000}
            autoFocus
            onChange={(event) => setBody(event.target.value)}
          />
          <Checkbox checked={proposing} onChange={(event) => setProposing(event.target.checked)}>
            {t('propose')}
          </Checkbox>
          {proposing && (
            <TextAreaField
              label={t('proposalLabel')}
              help={t('proposalHelp')}
              value={proposal}
              maxLength={10_000}
              onChange={(event) => setProposal(event.target.value)}
            />
          )}
          {error?.id === 'draft' && <Alert tone="error">{error.message}</Alert>}
          <div className={styles.commentFormActions}>
            <Button variant="secondary" onClick={props.onCancelDraft}>
              {t('cancel')}
            </Button>
            <Button type="submit" busy={busy === 'draft'} disabled={!body.trim()}>
              {t('publish')}
            </Button>
          </div>
        </form>
      )}

      {props.error && <Alert tone="error">{errorMessage(props.error)}</Alert>}
      {comments && comments.length > 0 && (
        <Tabs
          label={t('filter')}
          idPrefix="comments-filter"
          value={filter}
          onChange={(value) => setFilter(value as 'open' | 'resolved')}
          items={[
            { id: 'open', label: t('open', { count: openCount }) },
            { id: 'resolved', label: t('resolved', { count: resolvedCount }) },
          ]}
        />
      )}
      {comments === null && !props.error && (
        <p className={styles.loading} role="status">
          {t('loading')}
        </p>
      )}
      {comments && ordered.length === 0 && !draft && (
        <EmptyState
          icon={MessagesSquare}
          title={filter === 'open' ? t('emptyTitle') : t('emptyResolved')}
          text={rights.comment ? t('emptyHint') : t('emptyReader')}
        />
      )}
      {ordered.length > 0 && (
        <ol
          className={styles.commentList}
          role="tabpanel"
          id={`comments-filter-panel-${filter}`}
          aria-labelledby={`comments-filter-tab-${filter}`}
        >
          {ordered.map(card)}
        </ol>
      )}

      <ConfirmDialog
        open={confirming !== null}
        title={t('changedTitle')}
        text={t('changedText', {
          current: confirming?.current ?? '',
          proposal: confirming?.comment.suggestedText ?? '',
        })}
        confirmLabel={t('apply')}
        onConfirm={async () => (confirming ? apply(confirming.comment) : null)}
        onClose={() => setConfirming(null)}
      />
    </div>
  );
}
