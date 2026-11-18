import type { ProjectUsage } from '@integris/shared';

/** True when the plan forbids a new project (limit read from the `Plan` table by the API). */
export const atProjectLimit = (usage: ProjectUsage) =>
  usage.maxProjects !== null && usage.projects >= usage.maxProjects;
