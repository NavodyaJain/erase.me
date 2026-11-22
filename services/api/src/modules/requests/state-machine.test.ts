import { describe, expect, it } from 'vitest';
import { REQUEST_STATUSES } from '../../db/schema/enums.js';
import { assertTransition, canTransition, eventFor, PRE_SEND_STATUSES, type RequestStatus } from './state-machine.js';

describe('state machine', () => {
  it('allows the Phase 1 path and the edit loop', () => {
    expect(canTransition('drafted', 'approved')).toBe(true);
    expect(canTransition('approved', 'sent')).toBe(true);
    expect(canTransition('approved', 'drafted')).toBe(true); // an edit after approval
    expect(canTransition('drafted', 'closed')).toBe(true);
    expect(canTransition('approved', 'closed')).toBe(true);
  });

  it('never reaches sent without passing through approved', () => {
    for (const from of REQUEST_STATUSES) {
      if (from === 'approved') continue;
      expect(canTransition(from, 'sent'), `${from} -> sent`).toBe(false);
    }
  });

  it('does not let a sent request go back, be edited or be closed directly', () => {
    for (const to of ['drafted', 'approved', 'closed'] as RequestStatus[]) expect(canTransition('sent', to), `sent -> ${to}`).toBe(false);
  });

  it('has the later states already: sent leads to a reply, no_reply or bounced, and each ends closed', () => {
    for (const to of ['replied_deleted', 'replied_info_requested', 'replied_refused', 'no_reply', 'bounced'] as RequestStatus[]) {
      expect(canTransition('sent', to)).toBe(true);
    }
    for (const from of ['replied_deleted', 'replied_info_requested', 'replied_refused', 'no_reply'] as RequestStatus[]) {
      expect(canTransition(from, 'closed')).toBe(true);
    }
  });

  it('treats closed and bounced as final', () => {
    for (const to of REQUEST_STATUSES) {
      expect(canTransition('closed', to)).toBe(false);
      expect(canTransition('bounced', to)).toBe(false);
    }
  });

  it('has no self transitions', () => {
    for (const s of REQUEST_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it('records each transition as the right event type', () => {
    expect(eventFor('drafted', 'approved')).toBe('approved');
    expect(eventFor('approved', 'drafted')).toBe('edited');
    expect(eventFor('approved', 'sent')).toBe('sent');
    expect(eventFor('drafted', 'closed')).toBe('closed');
    expect(eventFor('sent', 'bounced')).toBe('bounced');
    expect(eventFor('sent', 'replied_deleted')).toBe('reply_label');
  });

  it('assertTransition throws a 409 with a stable code', () => {
    expect(() => assertTransition('drafted', 'sent')).toThrowError(expect.objectContaining({ status: 409, code: 'invalid_transition' }));
    expect(() => assertTransition('drafted', 'approved')).not.toThrow();
  });

  it('knows which states are still editable', () => {
    expect([...PRE_SEND_STATUSES]).toEqual(['drafted', 'approved']);
  });
});
