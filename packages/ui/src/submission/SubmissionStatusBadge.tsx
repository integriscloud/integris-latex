import { CircleCheck, Clock, Eye, FilePen, MessageSquareReply, RotateCcw } from 'lucide-react';
import { Badge, type BadgeTone } from '../badge/Badge';

export type SubmissionStatusName =
  'DRAFT' | 'SUBMITTED' | 'IN_REVIEW' | 'FEEDBACK_SENT' | 'REVISED' | 'VALIDATED';

const LOOK: Record<SubmissionStatusName, { tone: BadgeTone; icon: typeof Clock }> = {
  DRAFT: { tone: 'neutral', icon: FilePen },
  SUBMITTED: { tone: 'info', icon: Clock },
  IN_REVIEW: { tone: 'action', icon: Eye },
  FEEDBACK_SENT: { tone: 'warning', icon: MessageSquareReply },
  REVISED: { tone: 'info', icon: RotateCcw },
  // Success always carries a check.
  VALIDATED: { tone: 'success', icon: CircleCheck },
};

export interface SubmissionStatusBadgeProps {
  status: SubmissionStatusName;
  /** Translated name of the status. */
  label: string;
}

/** Status of a submission, from draft to validated (recurring component of the design brief). */
export function SubmissionStatusBadge({ status, label }: SubmissionStatusBadgeProps) {
  const look = LOOK[status];
  return (
    <Badge tone={look.tone} icon={look.icon}>
      {label}
    </Badge>
  );
}
