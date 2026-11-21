import { Ban, CircleCheck, Eye, Lock, Printer } from 'lucide-react';
import { Badge, type BadgeTone } from '../badge/Badge';

export type PrintStatusName =
  'SCHEDULED' | 'READY' | 'OPENED' | 'PRINTED' | 'HANDED_OVER' | 'CANCELED';

const LOOK: Record<PrintStatusName, { tone: BadgeTone; icon: typeof Lock }> = {
  SCHEDULED: { tone: 'info', icon: Lock },
  READY: { tone: 'action', icon: Printer },
  OPENED: { tone: 'warning', icon: Eye },
  PRINTED: { tone: 'accent', icon: Printer },
  // Success always carries a check.
  HANDED_OVER: { tone: 'success', icon: CircleCheck },
  CANCELED: { tone: 'neutral', icon: Ban },
};

export interface PrintStatusBadgeProps {
  status: PrintStatusName;
  /** Translated name of the status. */
  label: string;
}

/** Status of a print request of an exam paper, from scheduled (locked) to handed over. */
export function PrintStatusBadge({ status, label }: PrintStatusBadgeProps) {
  const look = LOOK[status];
  return (
    <Badge tone={look.tone} icon={look.icon}>
      {label}
    </Badge>
  );
}
