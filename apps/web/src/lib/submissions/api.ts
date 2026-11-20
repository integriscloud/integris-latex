import type {
  CreateSubmissionRequest,
  SendSubmissionRequest,
  SubmissionComparison,
  SubmissionDetail,
  SubmissionList,
  UpdateSubmissionRequest,
} from '@integris/shared';
import { apiPost, apiRead, apiRequest } from '../api-client';

const base = (projectId: string) => `projects/${projectId}/submissions`;

export const loadSubmissions = (projectId: string) => apiRead<SubmissionList>(base(projectId));

export const loadSubmission = (projectId: string, id: string) =>
  apiRead<SubmissionDetail>(`${base(projectId)}/${id}`);

export const createSubmission = (projectId: string, body: CreateSubmissionRequest) =>
  apiPost<SubmissionDetail>(base(projectId), body);

export const updateSubmission = (projectId: string, id: string, body: UpdateSubmissionRequest) =>
  apiRequest<SubmissionDetail>('PATCH', `${base(projectId)}/${id}`, body);

export const deleteSubmission = (projectId: string, id: string) =>
  apiRequest('DELETE', `${base(projectId)}/${id}`);

export const sendSubmission = (projectId: string, id: string, body: SendSubmissionRequest) =>
  apiPost<SubmissionDetail>(`${base(projectId)}/${id}/send`, body);

/** Reviewer actions: open (in review), feedback, unlock. */
export const submissionAction = (
  projectId: string,
  id: string,
  action: 'open' | 'feedback' | 'unlock',
) => apiPost<SubmissionDetail>(`${base(projectId)}/${id}/${action}`);

export const validateSubmission = (projectId: string, id: string, number: number) =>
  apiPost<SubmissionDetail>(`${base(projectId)}/${id}/validate`, { number });

export const setSubmissionDue = (projectId: string, id: string, dueAt: string | null) =>
  apiRequest<SubmissionDetail>('PATCH', `${base(projectId)}/${id}/due`, { dueAt });

export const compareSubmission = (projectId: string, id: string, from: number, to: number) =>
  apiRead<SubmissionComparison>(`${base(projectId)}/${id}/compare?from=${from}&to=${to}`);
