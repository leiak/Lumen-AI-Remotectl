/** Server recognizes these exact body strings as approval replies. */
export const APPROVAL_YES = 'yes' as const;
export const APPROVAL_NO = 'no' as const;
export const APPROVAL_VALUES = [APPROVAL_YES, APPROVAL_NO] as const;
export type ApprovalValue = typeof APPROVAL_VALUES[number];