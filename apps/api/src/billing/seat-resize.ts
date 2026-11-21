import type { Prisma } from '@integris/db';

/** A seat nobody holds nor reserves: never used, or released by its last holder. */
const UNTAKEN: Prisma.SeatWhereInput = {
  invitationId: null,
  OR: [{ userId: null }, { releasedAt: { not: null } }],
};

/**
 * Brings the seat rows of a subscription to `wanted`: adds rows, or deletes rows nobody holds nor
 * reserves (never-used ones first, then released ones). Every row counts, released ones too, so
 * an organization never keeps more usable seats than it pays for. The conditions are checked
 * again by the delete itself: a seat given or reserved meanwhile (organization lock) stays.
 * Returns the ids of the deleted seats.
 */
export async function resizeSeats(
  tx: Prisma.TransactionClient,
  subscriptionId: string,
  wanted: number,
): Promise<{ added: number; removed: string[] }> {
  const total = await tx.seat.count({ where: { subscriptionId } });
  if (wanted > total) {
    await tx.seat.createMany({
      data: Array.from({ length: wanted - total }, () => ({ subscriptionId })),
    });
    return { added: wanted - total, removed: [] };
  }
  if (wanted === total) return { added: 0, removed: [] };
  const candidates = await tx.seat.findMany({
    where: { subscriptionId, ...UNTAKEN },
    orderBy: { assignedAt: { sort: 'asc', nulls: 'first' } },
    take: total - wanted,
    select: { id: true },
  });
  const ids = candidates.map((seat) => seat.id);
  await tx.seat.deleteMany({ where: { id: { in: ids }, ...UNTAKEN } });
  const kept = await tx.seat.findMany({ where: { id: { in: ids } }, select: { id: true } });
  const keptIds = new Set(kept.map((seat) => seat.id));
  return { added: 0, removed: ids.filter((id) => !keptIds.has(id)) };
}
