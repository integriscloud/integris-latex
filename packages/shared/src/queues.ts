/** BullMQ queue of the compilations: the only keys the worker's Redis ACL user may reach. */
export const COMPILE_QUEUE = 'compile';

/**
 * SMS and e-mails of the notifications: Redis user `api` only, never granted to the `worker` ACL
 * user of the compile servers.
 */
export const NOTIFICATIONS_QUEUE = 'notifications';
