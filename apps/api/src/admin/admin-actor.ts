/** Who acts in the back-office, for the audit entries. */
export interface AdminActor {
  userId: string;
  ip: string | null;
}
